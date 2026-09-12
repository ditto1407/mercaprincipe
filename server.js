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
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const PAYPAL_BASE_URL = process.env.PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

// --- FUNCIÓN: Calcular costo de envío basado en el subtotal ---
// Fórmula: y = 0.078 * x + 4.89
// Donde x = subtotal de productos, y = costo de envío
function calcularCostoEnvio(subtotal) {
  const envio = (0.078 * subtotal) + 4.89;
  return Math.round(envio * 100) / 100; // Redondear a 2 decimales
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

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'El carrito está vacío' });
    }

    // 1. Buscar los precios REALES en la base de datos
    const productIds = items.map(item => item.product_id);
    const { data: products, error } = await supabase
      .from('products')
      .select('id, name, price, is_active')
      .in('id', productIds)
      .eq('is_active', true);

    if (error || !products || products.length === 0) {
      return res.status(400).json({ error: 'Uno o más productos no existen o no están disponibles' });
    }

    // 2. Calcular el subtotal usando los precios del servidor
    let subtotal = 0;
    const verifiedItems = [];

    for (const item of items) {
      const product = products.find(p => p.id === item.product_id);
      if (!product) {
        return res.status(400).json({ error: `Producto no encontrado: ${item.product_id}` });
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

    // 3. CALCULAR ENVÍO DINÁMICO usando la fórmula
    const shippingCost = calcularCostoEnvio(subtotal);
    const total = subtotal + shippingCost;

    // 4. Crear la orden en PayPal con el monto CORRECTO
    const token = await getPayPalToken();
    const paypalResponse = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
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
          description: 'Pedido MercaPrincipe - Entrega en Cuba',
          items: verifiedItems.map(item => ({
            name: item.product_name,
            quantity: item.quantity.toString(),
            unit_amount: { currency_code: 'USD', value: item.price.toFixed(2) }
          }))
        }]
      })
    });

    const paypalOrder = await paypalResponse.json();

    if (!paypalOrder.id) {
      console.error('Error PayPal:', paypalOrder);
      return res.status(500).json({ error: 'Error al crear orden en PayPal' });
    }

    // 5. Devolver al frontend la orden de PayPal y los datos verificados
    res.json({
      paypalOrderId: paypalOrder.id,
      total: total.toFixed(2),
      subtotal: subtotal.toFixed(2),
      shipping: shippingCost.toFixed(2),
      items: verifiedItems,
      approveUrl: paypalOrder.links.find(link => link.rel === 'approve')?.href
    });

  } catch (err) {
    console.error('Error en /api/create-order:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
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

// --- ENDPOINT PARA CALCULAR ENVÍO (útil para el frontend) ---
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
