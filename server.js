// ==========================================
// MercaPrincipe - Backend Seguro
// Servidor que verifica precios y protege pagos
// ==========================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const app = express();

// --- CONFIGURACIÓN ---
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const PAYPAL_BASE_URL = process.env.PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

// PayPal tiene un límite de 10 items por orden
const PAYPAL_MAX_ITEMS = 10;

// --- FUNCIÓN: Calcular costo de envío basado en el subtotal ---
function calcularCostoEnvio(subtotal) {
  const envio = (0.078 * subtotal) + 4.89;
  return Math.round(envio * 100) / 100;
}

// --- FUNCIÓN: Obtener token de PayPal ---
async function getPayPalToken() {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const data = await response.json();
  return data.access_token;
}

// ==========================================
// ENDPOINT 1: CALCULAR PRECIO REAL Y CREAR ORDEN PAYPAL
// ==========================================
app.post('/api/create-order', async (req, res) => {
  try {
    const { items } = req.body;
    console.log("📦 Productos recibidos del frontend:", items?.length, "productos");

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'El carrito está vacío' });
    }

    const productIds = items.map(item => item.product_id);

    // 1. Buscar los precios REALES en la base de datos
    const { data: products, error } = await supabase
      .from('products')
      .select('id, name, price, is_active')
      .in('id', productIds)
      .eq('is_active', true);

    if (error) {
      console.error("❌ Error de Supabase:", error);
      return res.status(500).json({ error: 'Error de base de datos al verificar productos' });
    }

    if (!products || products.length === 0) {
      return res.status(400).json({ error: 'Ninguno de los productos seleccionados está disponible.' });
    }

    // 2. Calcular el subtotal usando los precios del servidor
    let subtotal = 0;
    const verifiedItems = [];

    for (const item of items) {
      const product = products.find(p => p.id === item.product_id);
      
      if (!product) {
        console.warn(`⚠️ PRODUCTO RECHAZADO: El ID ${item.product_id} no está activo o no existe.`);
        return res.status(400).json({ error: `El producto con ID ${item.product_id} no está disponible.` });
      }
      
      if (item.quantity <= 0) {
        return res.status(400).json({ error: 'Cantidad inválida' });
      }

      const itemTotal = product.price * item.quantity;
      subtotal += itemTotal;
      verifiedItems.push({
        product_id: product.id,
        product_name: product.name,
        quantity: item.quantity,
        price: product.price,
        subtotal: itemTotal
      });
    }

    console.log("💰 Subtotal calculado:", subtotal.toFixed(2));

    // 3. CALCULAR ENVÍO DINÁMICO
    const shippingCost = calcularCostoEnvio(subtotal);
    const total = subtotal + shippingCost;
    console.log("🚚 Envío calculado:", shippingCost.toFixed(2), "| Total:", total.toFixed(2));

    // 4. PREPARAR ITEMS PARA PAYPAL (con límite de 10)
    let paypalItems;
    let description = 'Pedido MercaPrincipe - Entrega en Cuba';
    
    if (verifiedItems.length <= PAYPAL_MAX_ITEMS) {
      // Si hay 10 o menos productos, enviar todos normalmente
      paypalItems = verifiedItems.map(item => ({
        name: item.product_name.substring(0, 127), // PayPal limita a 127 caracteres
        quantity: item.quantity.toString(),
        unit_amount: { currency_code: 'USD', value: item.price.toFixed(2) }
      }));
    } else {
      // Si hay MÁS de 10 productos, agruparlos para que PayPal los acepte
      console.log(`📦 Agrupando ${verifiedItems.length} productos para PayPal (límite: ${PAYPAL_MAX_ITEMS})`);
      
      // Tomamos los primeros 9 productos individualmente
      paypalItems = verifiedItems.slice(0, PAYPAL_MAX_ITEMS - 1).map(item => ({
        name: item.product_name.substring(0, 127),
        quantity: item.quantity.toString(),
        unit_amount: { currency_code: 'USD', value: item.price.toFixed(2) }
      }));
      
      // Agrupamos el resto en un solo item llamado "Productos adicionales"
      const productosRestantes = verifiedItems.slice(PAYPAL_MAX_ITEMS - 1);
      const subtotalRestante = productosRestantes.reduce((sum, p) => sum + p.subtotal, 0);
      const cantidadRestante = productosRestantes.reduce((sum, p) => sum + p.quantity, 0);
      const precioPromedio = subtotalRestante / cantidadRestante;
      
      paypalItems.push({
        name: `Otros ${productosRestantes.length} productos`,
        quantity: cantidadRestante.toString(),
        unit_amount: { currency_code: 'USD', value: precioPromedio.toFixed(2) }
      });
      
      // Creamos una descripción detallada con todos los productos
      const nombresProductos = verifiedItems.map(p => `${p.quantity}x ${p.product_name}`).join(', ');
      description = `Pedido MercaPrincipe: ${nombresProductos.substring(0, 1000)}`;
    }

    // 5. Crear la orden en PayPal
    const token = await getPayPalToken();
    const paypalPayload = {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: 'USD',
          value: total.toFixed(2),
          breakdown: {
            item_total: { currency_code: 'USD', value: subtotal.toFixed(2) },
            shipping: { currency_code: 'USD', value: shippingCost.toFixed(2) }
          }
        },
        description: description
      }]
    };
    
    // Solo agregar items si hay 10 o menos (para evitar problemas de validación)
    if (verifiedItems.length <= PAYPAL_MAX_ITEMS) {
      paypalPayload.purchase_units[0].items = paypalItems;
    }

    console.log("💳 Enviando petición a PayPal...");
    const paypalResponse = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paypalPayload)
    });

    const paypalOrder = await paypalResponse.json();

    if (!paypalOrder.id) {
      console.error('❌ Error PayPal DETALLADO:', JSON.stringify(paypalOrder, null, 2));
      const errorMsg = paypalOrder.message || paypalOrder.name || 'Error desconocido de PayPal';
      return res.status(500).json({ error: `Error al crear orden en PayPal: ${errorMsg}` });
    }

    console.log("🎉 Orden de PayPal creada con éxito:", paypalOrder.id);

    // 6. Devolver al frontend
    res.json({
      paypalOrderId: paypalOrder.id,
      total: total.toFixed(2),
      subtotal: subtotal.toFixed(2),
      shipping: shippingCost.toFixed(2),
      items: verifiedItems,
      approveUrl: paypalOrder.links.find(link => link.rel === 'approve')?.href
    });

  } catch (err) {
    console.error('💥 Error catastrófico en /api/create-order:', err);
    res.status(500).json({ error: 'Error interno del servidor: ' + err.message });
  }
});

// ==========================================
// ENDPOINT 2: CONFIRMAR PAGO Y GUARDAR PEDIDO
// ==========================================
app.post('/api/confirm-order', async (req, res) => {
  try {
    const { paypalOrderId, datos } = req.body;

    if (!paypalOrderId || !datos) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    // 1. Capturar el pago en PayPal
    const token = await getPayPalToken();
    const captureResponse = await fetch(
      `${PAYPAL_BASE_URL}/v2/checkout/orders/${paypalOrderId}/capture`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const captureData = await captureResponse.json();

    if (captureData.status !== 'COMPLETED') {
      console.error('❌ PayPal no completó el pago:', captureData);
      return res.status(400).json({ error: 'El pago no fue completado por PayPal' });
    }

    // 2. Obtener el monto que PayPal REALMENTE cobró
    const paypalAmount = parseFloat(
      captureData.purchase_units[0].payments.captures[0].amount.value
    );

    // 3. Guardar el pedido en Supabase
    const paypalItems = captureData.purchase_units[0].items || [];
    
    const itemsSummary = paypalItems.length > 0
      ? paypalItems.map(i => `${i.quantity}x ${i.name}`).join(' | ') + ` | TOTAL: $${paypalAmount}`
      : `Total cobrado por PayPal: $${paypalAmount}`;

    const { data: pedido, error: errorPedido } = await supabase
      .from('orders')
      .insert({
        buyer_email: datos.buyer_email,
        buyer_name: datos.buyer_name,
        recipient_name: datos.recipient_name,
        recipient_last_name: datos.recipient_last_name,
        delivery_address: datos.delivery_address,
        delivery_city: datos.delivery_city || 'Camagüey',
        delivery_province: datos.delivery_province || 'Camagüey',
        delivery_postal_code: datos.delivery_postal_code || 'N/A',
        delivery_phone: datos.delivery_phone,
        guest_email: datos.buyer_email,
        total: paypalAmount,
        status: 'paid',
        payment_method: 'paypal',
        paypal_order_id: paypalOrderId,
        items_summary: itemsSummary,
        shipping_address: JSON.stringify({
          name: `${datos.recipient_name} ${datos.recipient_last_name}`,
          address: datos.delivery_address,
          city: datos.delivery_city || 'Camagüey',
          province: datos.delivery_province || 'Camagüey',
          postal_code: datos.delivery_postal_code || 'N/A',
          phone: datos.delivery_phone,
          country: 'Cuba'
        })
      })
      .select()
      .single();

    if (errorPedido) {
      console.error('Error guardando pedido:', errorPedido);
      return res.status(500).json({ error: 'Error al guardar el pedido' });
    }

    // 4. Guardar los items del pedido
    if (paypalItems.length > 0) {
      const itemsParaInsertar = paypalItems.map(item => ({
        order_id: pedido.id,
        product_name: item.name,
        quantity: parseInt(item.quantity),
        price: parseFloat(item.unit_amount.value)
      }));
      await supabase.from('order_items').insert(itemsParaInsertar);
    }

    // 5. Éxito
    res.json({
      success: true,
      orderId: pedido.id,
      total: paypalAmount.toFixed(2),
      message: 'Pedido registrado exitosamente'
    });

  } catch (err) {
    console.error('Error en /api/confirm-order:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// --- ENDPOINT DE PRUEBA ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'MercaPrincipe Backend funcionando 🚀' });
});

// --- ENDPOINT PARA CALCULAR ENVÍO ---
app.post('/api/calculate-shipping', (req, res) => {
  try {
    const { subtotal } = req.body;
    
    if (!subtotal || subtotal <= 0) {
      return res.status(400).json({ error: 'Subtotal inválido' });
    }

    const shippingCost = calcularCostoEnvio(subtotal);
    
    res.json({
      subtotal: subtotal.toFixed(2),
      shipping: shippingCost.toFixed(2),
      total: (subtotal + shippingCost).toFixed(2)
    });
  } catch (err) {
    console.error('Error en /api/calculate-shipping:', err);
    res.status(500).json({ error: 'Error al calcular envío' });
  }
});

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor MercaPrincipe corriendo en puerto ${PORT}`);
});
