// ==========================================================
// MercaPrincipe – Rutas de ADMINISTRACIÓN (solo servidor)
// - La contraseña NUNCA está en el código: solo su hash (scrypt) en variables de entorno.
// - Login con límite de intentos, token firmado (HMAC) que caduca a las 2 horas.
// - Todas las rutas /api/admin/products exigen token válido.
// ==========================================================
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

module.exports = function (app, supabase) {
  const USER = process.env.ADMIN_USER || '';
  const HASH = process.env.ADMIN_PASSWORD_HASH || '';
  const SECRET = process.env.ADMIN_TOKEN_SECRET || '';
  const HABILITADO = !!(USER && HASH && SECRET.length >= 32);
  if (!HABILITADO) console.warn('⚠️  Panel admin DESACTIVADO: faltan ADMIN_USER, ADMIN_PASSWORD_HASH o ADMIN_TOKEN_SECRET (mín. 32 caracteres).');

  app.set('trust proxy', 1); // Render está detrás de un proxy: necesario para ver la IP real
  const TTL = 2 * 60 * 60 * 1000; // sesión de 2 horas
  const CATEGORIAS = ['frutas','carnes','pescados','lacteos','panaderia','despensa','bebidas','congelados','snacks','especias','salud','hogar','cuidado'];

  // ---------- utilidades de seguridad ----------
  const sha = s => crypto.createHash('sha256').update(String(s)).digest();
  const iguales = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
  const firmar = payload => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  };
  const verificar = token => {
    try {
      const [body, sig] = String(token).split('.');
      if (!body || !sig) return null;
      const esperado = crypto.createHmac('sha256', SECRET).update(body).digest();
      const recibido = Buffer.from(sig, 'base64url');
      if (recibido.length !== esperado.length || !crypto.timingSafeEqual(recibido, esperado)) return null;
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      return (p.exp > Date.now() && p.u === USER) ? p : null;
    } catch (e) { return null; }
  };
  async function passwordOk(pw) {
    // Formato del hash: scrypt$<salt hex>$<hash hex>
    const [tipo, salt, hex] = HASH.split('$');
    if (tipo !== 'scrypt' || !salt || !hex) return false;
    const esperado = Buffer.from(hex, 'hex');
    const calc = await scrypt(String(pw), Buffer.from(salt, 'hex'), esperado.length);
    return crypto.timingSafeEqual(calc, esperado);
  }

  // ---------- límite de intentos por IP ----------
  const intentos = new Map(); // ip -> { n, desde, bloqueadoHasta }
  const VENTANA = 15 * 60 * 1000, MAX = 5;
  setInterval(() => { const t = Date.now(); intentos.forEach((v, k) => { if (t - v.desde > VENTANA && t > (v.bloqueadoHasta || 0)) intentos.delete(k); }); }, 60 * 1000).unref();
  const espera = ms => new Promise(r => setTimeout(r, ms));

  app.use('/api/admin', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.post('/api/admin/login', async (req, res) => {
    if (!HABILITADO) return res.status(503).json({ error: 'Panel admin no configurado en el servidor' });
    const ip = req.ip, ahora = Date.now();
    let r = intentos.get(ip) || { n: 0, desde: ahora };
    if (ahora - r.desde > VENTANA) r = { n: 0, desde: ahora };
    if (r.bloqueadoHasta && ahora < r.bloqueadoHasta) {
      return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.', retryAfter: Math.ceil((r.bloqueadoHasta - ahora) / 1000) });
    }
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 200) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }
    // Se verifica SIEMPRE usuario y contraseña (misma duración si falla uno u otro)
    const userOk = iguales(username.trim().toLowerCase(), USER.toLowerCase());
    const passOk = await passwordOk(password);
    if (userOk && passOk) {
      intentos.delete(ip);
      console.log('🔐 Login admin correcto desde', ip);
      return res.json({ token: firmar({ u: USER, exp: Date.now() + TTL }), expiresIn: TTL / 1000 });
    }
    r.n += 1;
    if (r.n >= MAX) r.bloqueadoHasta = ahora + VENTANA;
    intentos.set(ip, r);
    console.warn('⛔ Intento de login admin fallido desde', ip, `(${r.n}/${MAX})`);
    await espera(700);
    res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  });

  function requireAdmin(req, res, next) {
    if (!HABILITADO) return res.status(503).json({ error: 'Panel admin no configurado' });
    const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
    if (!m || !verificar(m[1])) return res.status(401).json({ error: 'Sesión no válida o expirada' });
    next();
  }

  // ---------- validación (lista blanca de campos) ----------
  function validar(b, actual) {
    const e = [], o = {};
    const has = k => Object.prototype.hasOwnProperty.call(b, k);
    if (has('name')) { const v = String(b.name || '').trim(); if (v.length < 2 || v.length > 200) e.push('Nombre: entre 2 y 200 caracteres'); else o.name = v; }
    if (has('category')) { if (!CATEGORIAS.includes(b.category)) e.push('Categoría no válida'); else o.category = b.category; }
    if (has('price')) { const v = Number(b.price); if (!isFinite(v) || v <= 0 || v > 100000) e.push('Precio debe ser mayor que 0'); else o.price = Math.round(v * 100) / 100; }
    if (has('old_price')) {
      if (b.old_price === null || b.old_price === '') o.old_price = null;
      else { const v = Number(b.old_price); if (!isFinite(v) || v <= 0 || v > 100000) e.push('Precio anterior no válido'); else o.old_price = Math.round(v * 100) / 100; }
    }
    if (has('image')) {
      const v = String(b.image || '').trim();
      if (v === '') o.image = null;
      else if (v.length > 600 || !(/^https:\/\/\S+$/i.test(v) || /^images\/[\w\-./]+$/.test(v))) e.push('Imagen: usa un enlace https:// o una ruta images/archivo.png');
      else o.image = v;
    }
    if (has('badge')) { const v = String(b.badge || '').trim(); if (v.length > 30) e.push('Etiqueta: máximo 30 caracteres'); else o.badge = v || null; }
    if (has('sales_count')) { const v = Number(b.sales_count); if (!Number.isInteger(v) || v < 0 || v > 10000000) e.push('Ventas debe ser un entero ≥ 0'); else o.sales_count = v; }
    if (has('is_active')) { if (typeof b.is_active !== 'boolean') e.push('Estado no válido'); else o.is_active = b.is_active; }
    const m = { ...(actual || {}), ...o };
    if (m.old_price != null && m.price != null && m.old_price <= m.price) e.push('El precio anterior debe ser mayor que el precio actual (o déjalo vacío)');
    return { e, o };
  }
  const idOk = id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
  const fallo = (res, error, msg) => { console.error('Admin DB:', error.message); res.status(500).json({ error: msg || 'Error en la base de datos: ' + error.message }); };

  // ---------- productos ----------
  app.get('/api/admin/products', requireAdmin, async (req, res) => {
    try {
      let todos = [], desde = 0;
      for (;;) {
        const { data, error } = await supabase.from('products').select('*').order('name', { ascending: true }).range(desde, desde + 999);
        if (error) return fallo(res, error);
        todos = todos.concat(data); if (data.length < 1000 || todos.length >= 10000) break; desde += 1000;
      }
      res.json({ products: todos, categories: CATEGORIAS });
    } catch (err) { fallo(res, err); }
  });

  app.post('/api/admin/products', requireAdmin, async (req, res) => {
    const { e, o } = validar(req.body || {}, null);
    if (!o.name) e.push('Falta el nombre'); if (!o.category) e.push('Falta la categoría'); if (o.price == null) e.push('Falta el precio');
    if (e.length) return res.status(400).json({ error: e.join('. ') });
    const fila = { sales_count: 0, is_active: true, ...o };
    try {
      let { data, error } = await supabase.from('products').insert(fila).select().single();
      if (error && /\bid\b/i.test(error.message) && /null/i.test(error.message)) { // si tu tabla no genera el id sola
        ({ data, error } = await supabase.from('products').insert({ id: crypto.randomUUID(), ...fila }).select().single());
      }
      if (error) return fallo(res, error);
      console.log('➕ Producto creado:', data.name);
      res.status(201).json({ product: data });
    } catch (err) { fallo(res, err); }
  });

  app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
    if (!idOk(req.params.id)) return res.status(400).json({ error: 'ID no válido' });
    try {
      const { data: actual, error: e0 } = await supabase.from('products').select('*').eq('id', req.params.id).maybeSingle();
      if (e0) return fallo(res, e0);
      if (!actual) return res.status(404).json({ error: 'Producto no encontrado' });
      const { e, o } = validar(req.body || {}, actual);
      if (e.length) return res.status(400).json({ error: e.join('. ') });
      if (!Object.keys(o).length) return res.status(400).json({ error: 'Nada que actualizar' });
      const { data, error } = await supabase.from('products').update(o).eq('id', req.params.id).select().single();
      if (error) return fallo(res, error);
      console.log('✏️  Producto actualizado:', data.name, Object.keys(o).join(','));
      res.json({ product: data });
    } catch (err) { fallo(res, err); }
  });

  app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
    if (!idOk(req.params.id)) return res.status(400).json({ error: 'ID no válido' });
    try {
      const { data, error } = await supabase.from('products').delete().eq('id', req.params.id).select('name');
      if (error) {
        if (error.code === '23503') return res.status(409).json({ error: 'Este producto aparece en pedidos anteriores y no se puede borrar. Inhabilítalo para ocultarlo de la tienda.' });
        return fallo(res, error);
      }
      if (!data || !data.length) return res.status(404).json({ error: 'Producto no encontrado' });
      console.log('🗑️  Producto eliminado:', data[0].name);
      res.json({ success: true });
    } catch (err) { fallo(res, err); }
  });
};
