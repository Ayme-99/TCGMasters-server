'use strict';

// Monta el módulo de Incursiones (T-08, repo TCG-Raid-Battles) en este
// servidor: mismas cuentas (modelo User), mismo JWT (`protect`) y misma base
// de MongoDB. Este archivo es de este servidor; el resto de src/modules/tcg-raid-battles/
// se regenera desde el repo de Incursiones (ver ORIGEN.md).
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const protect = require('../usuarios/middleware/authMiddleware');
const User = require('../usuarios/models/User');
const {
  crearRouter, crearRepoMongo, crearRepoMemoria, crearSalas, montarSalas,
} = require('./index');

// El módulo pide el repositorio al crear el router, pero la conexión de
// Mongoose se abre después de arrancar. Este repositorio espera a la
// conexión en la primera petición y entonces crea los índices (una vez).
function repoPerezoso(conexion) {
  let listo = null;
  const real = () => {
    if (!listo) {
      listo = (async () => {
        await conexion.asPromise();
        const repo = crearRepoMongo(conexion.db);
        await repo.asegurarIndices();
        return repo;
      })();
      // Si falla (la base no responde), la siguiente petición lo reintenta.
      listo.catch(() => { listo = null; });
    }
    return listo;
  };
  const metodos = Object.keys(crearRepoMemoria());
  return Object.fromEntries(
    metodos.map((m) => [m, async (...args) => (await real())[m](...args)]),
  );
}

// Ids de cuenta que no existen. Un id que no es un ObjectId tampoco existe.
async function cuentasQueFaltan(ids) {
  const validos = ids.filter((id) => mongoose.isValidObjectId(id));
  const hay = new Set(
    (await User.find({ _id: { $in: validos } }).select('_id').lean()).map((u) => String(u._id)),
  );
  return ids.filter((id) => !hay.has(id));
}

// Nombre de usuario de una cuenta, o null si no existe.
async function nombreDeCuenta(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const usuario = await User.findById(id).select('username').lean();
  return usuario ? usuario.username : null;
}

// Verifica el token de sesión que llega en el primer mensaje del WebSocket
// (el mismo JWT y el mismo secreto que `protect`). Devuelve la cuenta y su
// nombre, o null si el token no vale o la cuenta ya no existe.
function crearVerificadorToken({ buscarNombre = nombreDeCuenta } = {}) {
  return async (token) => {
    try {
      const { userId } = jwt.verify(token, process.env.JWT_SECRET);
      if (!userId) return null;
      const cuentaId = String(userId);
      const nombre = await buscarNombre(cuentaId);
      return nombre ? { cuentaId, nombre } : null;
    } catch {
      return null;
    }
  };
}

// Las opciones solo se cambian en los tests. El router lleva las salas
// (`router.salas`) para que el WebSocket use las mismas.
function montarIncursiones({
  repo = repoPerezoso(mongoose.connection),
  autenticar = protect,
  existenCuentas = cuentasQueFaltan,
  salas = crearSalas(),
} = {}) {
  const router = crearRouter({
    repo,
    autenticar,
    usuarioDe: (req) => (req.userId ? String(req.userId) : undefined),
    existenCuentas,
    salas,
  });
  router.salas = salas;
  return router;
}

// WebSocket de las salas (`/api/incursiones/ws`) sobre el servidor HTTP que
// devuelve `app.listen`. Hay que llamarlo con el router de `montarIncursiones`.
function montarWebSocketIncursiones(servidor, router, {
  verificarToken = crearVerificadorToken(),
} = {}) {
  return montarSalas({ servidor, salas: router.salas, verificarToken });
}

module.exports = montarIncursiones;
module.exports.montarWebSocketIncursiones = montarWebSocketIncursiones;
module.exports.crearVerificadorToken = crearVerificadorToken;
