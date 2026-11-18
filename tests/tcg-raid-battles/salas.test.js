const express = require('express');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const montarIncursiones = require('../../src/modules/tcg-raid-battles/montar');
const { crearRepoMemoria } = require('../../src/modules/tcg-raid-battles');

const { montarWebSocketIncursiones, crearVerificadorToken } = montarIncursiones;

// Salas de Incursiones (D-19): POST /salas con el JWT del servidor y WebSocket
// en /api/incursiones/ws con el mismo token en el primer mensaje.
const SECRETO = 'secreto-de-prueba';
const NOMBRES = { ana: 'Ana', bea: 'Bea', cai: 'Cai', dai: 'Dai' }; // cuentas que "existen"
const token = (userId) => jwt.sign({ userId }, SECRETO);
const EVENTO = { tipo: 'turnoJugador', jugador: 1, dano: 120 };

let servidor;
let ws;
let puerto;
const secretoOriginal = process.env.JWT_SECRET;
const abiertos = [];

beforeAll(async () => {
  process.env.JWT_SECRET = SECRETO;
  const app = express();
  app.use('/api/incursiones', express.json({ limit: '1mb' }));
  const router = montarIncursiones({ repo: crearRepoMemoria(), existenCuentas: async () => [] });
  app.use('/api/incursiones', router);
  await new Promise((ok) => { servidor = app.listen(0, ok); });
  puerto = servidor.address().port;
  ws = montarWebSocketIncursiones(servidor, router, {
    verificarToken: crearVerificadorToken({ buscarNombre: async (id) => NOMBRES[id] ?? null }),
  });
});

afterAll(async () => {
  process.env.JWT_SECRET = secretoOriginal;
  abiertos.forEach((s) => s.terminate());
  await ws.cerrar();
  await new Promise((ok) => servidor.close(ok));
});

const crearSala = async (usuario) => {
  const r = await fetch(`http://127.0.0.1:${puerto}/api/incursiones/salas`, {
    method: 'POST',
    headers: usuario ? { authorization: `Bearer ${token(usuario)}` } : {},
  });
  return { estado: r.status, json: await r.json() };
};

// Cliente de pruebas: guarda lo recibido y espera un mensaje por tipo.
const conectar = async () => {
  const s = new WebSocket(`ws://127.0.0.1:${puerto}/api/incursiones/ws`);
  const recibidos = [];
  const esperas = [];
  s.on('message', (d) => {
    const m = JSON.parse(d.toString());
    recibidos.push(m);
    for (const e of [...esperas]) {
      if (e.ok(m)) { esperas.splice(esperas.indexOf(e), 1); e.res(m); }
    }
  });
  await new Promise((res, rej) => { s.on('open', res); s.on('error', rej); });
  abiertos.push(s);
  return {
    s,
    recibidos,
    mandar: (m) => s.send(JSON.stringify(m)),
    siguiente: (tipo, cond = () => true) => {
      const ya = recibidos.find((m) => m.tipo === tipo && cond(m) && !m.visto);
      if (ya) { ya.visto = true; return Promise.resolve(ya); }
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`no llegó ${tipo}: ${JSON.stringify(recibidos)}`)), 3000);
        esperas.push({ ok: (m) => m.tipo === tipo && cond(m), res: (m) => { clearTimeout(t); m.visto = true; res(m); } });
      });
    },
  };
};

const entrar = async (cliente, usuario, codigo) => {
  cliente.mandar({ tipo: 'hola', protocolo: 1, token: token(usuario), codigo });
  return cliente.siguiente('sala');
};

describe('salas de Incursiones', () => {
  test('crear una sala exige sesión', async () => {
    const r = await crearSala(null);
    expect(r.estado).toBe(401);
  });

  test('el host crea la sala y entra con su nombre de usuario', async () => {
    const r = await crearSala('ana');
    expect(r.estado).toBe(201);
    expect(r.json.codigo).toMatch(/^[A-Z2-9]{5}$/);
    const host = await conectar();
    const sala = await entrar(host, 'ana', r.json.codigo);
    expect(sala).toMatchObject({ estado: 'abierta', host: 0, tuAsiento: 0 });
    expect(sala.jugadores).toEqual([{ asiento: 0, nombre: 'Ana', conectado: true }]);
  });

  test('un token inválido o de una cuenta que no existe no entra', async () => {
    const { json: { codigo } } = await crearSala('bea');
    const a = await conectar();
    a.mandar({ tipo: 'hola', protocolo: 1, token: 'no-es-un-jwt', codigo });
    expect((await a.siguiente('error')).codigo).toBe('sesionNoValida');
    const b = await conectar();
    b.mandar({ tipo: 'hola', protocolo: 1, token: token('fantasma'), codigo });
    expect((await b.siguiente('error')).codigo).toBe('sesionNoValida');
  });

  test('dos jugadores: empezar, proponer, aceptar y difundir el evento', async () => {
    // Una cuenta solo puede estar en una sala: cada test usa las suyas.
    const { json: { codigo } } = await crearSala('cai');
    const host = await conectar();
    await entrar(host, 'cai', codigo);
    const otra = await conectar();
    const s = await entrar(otra, 'dai', codigo);
    expect(s.tuAsiento).toBe(1);
    host.mandar({ tipo: 'empezar', partidaId: 'p-1', creadaEn: '2026-11-18T22:00:00.000Z' });
    await otra.siguiente('sala', (m) => m.estado === 'enCurso');
    otra.mandar({ tipo: 'proponer', idMensaje: 'm-1', evento: EVENTO });
    const propuesta = await host.siguiente('proponer');
    expect(propuesta).toMatchObject({ idMensaje: 'm-1', asiento: 1 });
    host.mandar({ tipo: 'aceptar', seq: 1, evento: EVENTO, idMensaje: 'm-1' });
    const evento = await otra.siguiente('evento');
    expect(evento).toMatchObject({ seq: 1, idMensaje: 'm-1' });
  });
});
