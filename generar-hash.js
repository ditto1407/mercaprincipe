// Uso:  node generar-hash.js "TuNuevaContraseña"
// Imprime el hash para ADMIN_PASSWORD_HASH y un ADMIN_TOKEN_SECRET nuevo. No guarda nada.
const crypto = require('crypto');
const pw = process.argv[2];
if (!pw || pw.length < 8) { console.error('Uso: node generar-hash.js "contraseña de 8+ caracteres"'); process.exit(1); }
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pw, salt, 64);
console.log('\nADMIN_PASSWORD_HASH=scrypt$' + salt.toString('hex') + '$' + hash.toString('hex'));
console.log('ADMIN_TOKEN_SECRET=' + crypto.randomBytes(48).toString('hex') + '\n');
