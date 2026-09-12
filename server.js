// ==========================================
// MercaPrincipe - Backend Seguro
// Servidor que verifica precios, protege pagos y cuenta ventas
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

// --- FUNCIÓN: Calcular costo de envío ---
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

    let subtotalEnCentavos = 0;
    const verifiedItems = [];
    const paypalItems = [];

    for (const item of items) {
      const product = products.find(p => p.id === item.product_id);
      
      if (!product) {
        return res.status(400).json({ error: `El producto con ID ${item.product_id} no está disponible.` });
      }
      if (item.quantity <= 0) {
        return res.status(400).json({ error: 'Cantidad inválida' });
      }

      const priceInCents = Math.round(product.price * 100);
      const itemTotalInCents = priceInCents * item.quantity;
      subtotalEnCentavos += itemTotalInCents;
      
      verifiedItems.push({
        product_id: product.id,
        product_name: product.name,
        quantity: item.quantity,
        price: product.price,
        subtotal: itemTotalInCents / 100
      });

      paypalItems.push({
        name: product.name.substring(0, 127),
        quantity: item.quantity.toString(),
        unit_amount: { currency_code: 'USD', value: (priceInCents / 100).toFixed(2) }
      });
    }

    const subtotal = subtotalEnCentavos / 100;
    const shippingCost = calcularCostoEnvio(subtotal);
    const total = subtotal + shippingCost;

    const token = await getPayPalToken();
    const nombresProductos = verifiedItems.map(p => `${p.quantity}x ${p.product_name}`).join(', ');
    const description = `Pedido MercaPrincipe: ${nombresProductos.substring(0, 1000)}`;
    
    const itemTotalForPayPal = (subtotalEnCentavos / 100).toFixed(2);
    
    const paypalPayload = {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: 'USD',
          value: total.toFixed(2),
          breakdown: {
            item_total: { currency_code: 'USD', value: itemTotalForPayPal },
            shipping: { currency_code: 'USD', value: shippingCost.toFixed(2) }
          }
        },
        description: description,
        items: paypalItems.length <= 10 ? paypalItems : undefined
      }]
    };

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

    res.json({
      paypalOrderId: paypalOrder.id,
      total: total.toFixed(2),
      subtotal: subtotal.toFixed(2),
      shipping: shippingCost.toFixed(2),
      items: verifiedItems
    });

  } catch (err) {
    console.error(' Error catastrófico en /api/create-order:', err);
    res.status(500).json({ error: 'Error interno del servidor: ' + err.message });
  }
});

// ==========================================
// ENDPOINT 2: CONFIRMAR PAGO, GUARDAR PEDIDO Y ACTUALIZAR VENTAS
// ==========================================
app.post('/api/confirm-order', async (req, res) => {
  try {
    const { paypalOrderId, datos } = req.body;

    if (!paypalOrderId || !datos) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

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

    const paypalAmount = parseFloat(
      captureData.purchase_units[0].payments.captures[0].amount.value
    );

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

    if (paypalItems.length > 0) {
      const itemsParaInsertar = paypalItems.map(item => ({
        order_id: pedido.id,
        product_name: item.name,
        quantity: parseInt(item.quantity),
        price: parseFloat(item.unit_amount.value)
      }));
      await supabase.from('order_items').insert(itemsParaInsertar);

      // 🔥 ACTUALIZAR CONTADOR DE VENTAS (sales_count)
      for (const item of paypalItems) {
        const quantity = parseInt(item.quantity);
        
        const { data: producto } = await supabase
          .from('products')
          .select('id, sales_count')
          .ilike('name', item.name)
          .single();

        if (producto) {
          const nuevoContador = (producto.sales_count || 0) + quantity;
          await supabase
            .from('products')
            .update({ sales_count: nuevoContador })
            .eq('id', producto.id);
          
          console.log(`✅ Ventas actualizadas para "${item.name}": ${nuevoContador}`);
        }
      }
    }

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
    if (!subtotal || subtotal <= 0) return res.status(400).json({ error: 'Subtotal inválido' });
    const shippingCost = calcularCostoEnvio(subtotal);
    res.json({ subtotal: subtotal.toFixed(2), shipping: shippingCost.toFixed(2), total: (subtotal + shippingCost).toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: 'Error al calcular envío' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor MercaPrincipe corriendo en puerto ${PORT}`);
});
