/**
 * SIE 2028 — core/pipeline2028.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orquestador del pipeline completo Capas 0 → 1 → 2 → renorm → 3.
 *
 * RESPONSABILIDADES:
 *   - Punto de entrada único: runPipeline2028(ctx, params)
 *   - Conecta los módulos sin tocar ninguno de los archivos existentes
 *   - Output compatible con el shape que consumen las views existentes
 *
 * ARQUITECTURA (resumen):
 *
 *   ctx (cargado por data.loadCTX)
 *    │
 *    ├─► Capa 0: clasificarPartidos()           → ctx._clasificacion
 *    │
 *    ├─► Capa 1: proyectarConBlindaje()         → ctx.r[2028] (shares 2028)
 *    │           (o encuestas ponderadas si existen)
 *    │
 *    ├─► Capa 2: calcArrastre() por nivel       → votes corregidos con ticket-split
 *    │           coeficientes calibrados 2020+2024
 *    │
 *    ├─► renormalizarCtx()                      → coherencia sum(prov) = nacional
 *    │
 *    └─► Capa 3: calcResultados2028()
 *               ├─ calcPresidencial()           → ganador / segunda vuelta
 *               ├─ calcSenadores()              → 32 senadores (pluralidad)
 *               ├─ calcDiputados()              → 190 dip (D'Hondt)
 *               ├─ calcGanadoresPluralidad(mun) → alcaldes
 *               └─ calcGanadoresPluralidad(dm)  → directores DM
 *
 * USO DESDE views/simulador.js o app.js:
 *
 *   import { runPipeline2028 } from './core/pipeline2028.js';
 *
 *   const result = await runPipeline2028(ctx, {
 *     ajusteParticipacion: 0,      // slider ±0.05
 *     ajustesPP: { PRM: +2 },      // ajustes manuales en pp
 *     aplicarArrastre: true,       // activar Capa 2
 *     ganadorPres: 'PRM',          // partido que "arrastra"
 *   });
 *
 *   // result.pres, result.sen, result.dip, result.mun, result.dm
 *   // result.alertas, result.trazabilidad
 *
 * COMPATIBILIDAD:
 *   - No modifica ningún archivo existente
 *   - El resultado extiende (no reemplaza) lo que simular() producía
 *   - Si ctx._clasificacion ya existe, no lo recalcula
 */

import { clasificarPartidos }            from './capa0_clasificador.js';
import { proyectarConBlindaje,
         calcArrastre, calcPesoEncuesta } from './capa1_proyeccion.js';
import { buildCtx2028, proyectarPadron,
         proyectarResultados }           from './proyeccion2028.js';
import { renormalizarCtx }               from './renormalizar_votos.js';
import { calcResultados2028 }            from './capa3_resultados.js';
import { getLevel }                      from './data.js';
import { clamp, rankVotes }              from './utils.js';

// Coeficientes de retención empíricos (calibrados 2020+2024, error 0.08pp)
var RETENCION = { sen: 0.9254, dip: 0.8955, mun: 0.88, dm: 0.87 };

/**
 * Ejecuta el pipeline completo para 2028.
 *
 * @param {object} ctx
 * @param {object} [params]
 * @param {number}  params.ajusteParticipacion  slider ±0.05 (default 0)
 * @param {object}  params.ajustesPP            { partido: pp } ajustes manuales
 * @param {boolean} params.aplicarArrastre      activar Capa 2 (default true)
 * @param {string}  params.ganadorPres          partido que arrastra (si aplicarArrastre)
 * @param {boolean} params.forzarReclasificar   recalcular Capa 0 aunque ya exista
 * @returns {ElectoralResult2028 & { ctx2028 }}
 */
export function runPipeline2028(ctx, params) {
  params = params || {};
  var ajusteParticipacion = typeof params.ajusteParticipacion === 'number'
    ? clamp(params.ajusteParticipacion, -0.05, 0.05) : 0;
  var ajustesPP     = params.ajustesPP     || {};
  var aplicarArr    = params.aplicarArrastre !== false;  // default true
  var ganadorPres   = params.ganadorPres   || _detectGanador(ctx);

  // ── Capa 0: Clasificación (una sola vez) ────────────────────────────────
  if (!ctx._clasificacion || params.forzarReclasificar) {
    ctx._clasificacion = clasificarPartidos();
  }
  var clasificacion = ctx._clasificacion;

  // ── Capa 1: Proyección 2028 con blindaje ────────────────────────────────
  // buildCtx2028 llama internamente a proyectarResultados → _desdeTendencia
  // Aquí la reemplazamos con proyectarConBlindaje para cada nivel
  var padron   = proyectarPadron(ctx, ajusteParticipacion);
  var em2028   = padron.emitidosProyectados;

  var ctx2028  = Object.assign({}, ctx, {
    padron2028: padron,
    r: Object.assign({}, ctx.r),
    _clasificacion: clasificacion,
  });
  ctx2028.r[2028] = {};

  var niveles = ['pres', 'sen', 'dip', 'mun', 'dm'];
  var trazCapas = {};

  niveles.forEach(function(nivel) {
    var lv24  = getLevel(ctx, 2024, nivel);
    var nat24 = lv24.nacional;
    var em24  = nat24.emitidos || 1;
    var v24   = nat24.votes    || {};

    // Usar polls si están disponibles y tienen calidad suficiente
    var polls = (ctx.polls || []).filter(function(p) { return !p._ejemplo; });
    var proj;
    if (polls.length) {
      // Ponderación por recencia + calidad
      proj = _proyectarDesdeEncuestas(polls, clasificacion);
      proj.fuente = 'encuestas';
    } else {
      proj = proyectarConBlindaje(ctx, clasificacion, nivel);
    }

    // Aplicar ajustes manuales (pp) sobre shares proyectados
    if (Object.keys(ajustesPP).length) {
      proj = _aplicarAjustesPP(proj, ajustesPP, em2028);
    }

    // Escalar shares a votos absolutos 2028
    var votes2028 = {};
    Object.keys(proj.votes2028).forEach(function(p) {
      votes2028[p] = Math.round((proj.votes2028[p] || 0) * em2028);
    });

    // Proyectar provincias uniformemente (Uniform Swing)
    var prov24  = lv24.prov || {};
    var prov28  = _scaleProvVotes(prov24, v24, proj.votes2028, em24, em2028, padron);

    // Proyectar circ para dip
    var circ28 = {};
    if (nivel === 'dip') {
      var circ24 = lv24.circ || {};
      circ28 = _scaleCircVotes(circ24, v24, proj.votes2028, em24, em2028);
    }

    ctx2028.r[2028][nivel] = Object.assign({}, lv24, {
      nacional: Object.assign({}, nat24, {
        votes:    votes2028,
        emitidos: em2028,
        validos:  Math.round(em2028 * 0.985),   // ~1.5% nulos histórico
        inscritos: padron.total,
      }),
      prov:        prov28,
      circ:        circ28,
      _proyeccion: proj,
    });

    trazCapas[nivel] = { fuente: proj.fuente, trazabilidad: proj.trazabilidad };
  });

  // ── Capa 2: Arrastre presidencial ────────────────────────────────────────
  if (aplicarArr && ganadorPres) {
    var preNat  = ctx2028.r[2028].pres.nacional;
    var presVts = preNat.votes;
    var presEm  = preNat.emitidos;
    var margenPres = _calcMargenPres(presVts, preNat.validos);

    ['sen', 'dip', 'mun', 'dm'].forEach(function(nivel) {
      var lv2028 = ctx2028.r[2028][nivel];
      if (!lv2028 || !lv2028.nacional) return;
      var emNivel = lv2028.nacional.emitidos || 0;
      var arrastre = calcArrastre(
        presVts, presEm, nivel, emNivel, ganadorPres, margenPres, clasificacion
      );
      lv2028.nacional.votes = arrastre.votes;
      lv2028.nacional._arrastre = arrastre.trazabilidad;

      // Propagar el swing del arrastre a provincias
      if (lv2028.prov && Object.keys(lv2028.prov).length) {
        var baseNat = presVts, simNat = arrastre.votes;
        lv2028.prov = _scaleProvFromNat(lv2028.prov, baseNat, simNat, emNivel);
      }
    });
  }

  // ── Renormalización ──────────────────────────────────────────────────────
  var ctxNorm = renormalizarCtx(ctx2028);

  // ── Capa 3: Resultados electorales ──────────────────────────────────────
  var resultado = calcResultados2028(ctxNorm);

  // Adjuntar ctx2028 normalizado para que la UI pueda acceder al mapa, etc.
  resultado.ctx2028    = ctxNorm;
  resultado.padron2028 = padron;
  resultado._trazCapas = trazCapas;

  return resultado;
}

// ─── Helpers internos ────────────────────────────────────────────────────────

function _detectGanador(ctx) {
  var lv24 = getLevel(ctx, 2024, 'pres');
  var ranked = rankVotes(lv24.nacional.votes || {}, lv24.nacional.validos);
  return ranked.length ? ranked[0].p : 'PRM';
}

function _calcMargenPres(votes, validos) {
  var ranked = rankVotes(votes, validos);
  if (ranked.length < 2) return ranked.length ? ranked[0].pct : 0;
  return ranked[0].pct - ranked[1].pct;
}

function _proyectarDesdeEncuestas(polls, clasificacion) {
  var pesos = polls.map(function(p) {
    return 1 / (1 + Math.max(0, _mesesDesde(p.fecha)));
  });
  var sumP = pesos.reduce(function(a, v) { return a + v; }, 0) || 1;
  var acc  = {};
  polls.forEach(function(p, i) {
    var w   = pesos[i] / sumP;
    var res = p.resultados || {};
    Object.keys(res).forEach(function(partido) {
      acc[partido] = (acc[partido] || 0) + (res[partido] / 100) * w;
    });
  });
  var tot = Object.values(acc).reduce(function(a, v) { return a + v; }, 0) || 1;
  var out = {};
  Object.keys(acc).forEach(function(p) { out[p] = acc[p] / tot; });
  return { votes2028: out, fuente: 'encuestas', trazabilidad: [] };
}

function _mesesDesde(fechaStr) {
  if (!fechaStr) return 12;
  var d = new Date(fechaStr);
  var now = new Date();
  return Math.max(0, (now - d) / (1000 * 60 * 60 * 24 * 30));
}

function _aplicarAjustesPP(proj, ajustesPP, em2028) {
  var shares = Object.assign({}, proj.votes2028);
  Object.entries(ajustesPP).forEach(function(e) {
    var p = e[0]; var pp = e[1] / 100;
    shares[p] = Math.max(0, (shares[p] || 0) + pp);
  });
  var tot = Object.values(shares).reduce(function(a, v) { return a + v; }, 0) || 1;
  var norm = {};
  Object.keys(shares).forEach(function(p) { norm[p] = shares[p] / tot; });
  return Object.assign({}, proj, { votes2028: norm });
}

function _scaleProvVotes(prov24, baseNatVotes, projShares, em24, em2028, padron) {
  var out   = {};
  var scale = em24 > 0 ? em2028 / em24 : 1;
  var tot24 = Object.values(baseNatVotes).reduce(function(a, v) { return a + v; }, 0) || 1;

  Object.entries(prov24).forEach(function(e) {
    var id  = e[0];
    var p24 = e[1];
    var newVotes = {};
    Object.keys(p24.votes || {}).forEach(function(par) {
      var baseShare = (baseNatVotes[par] || 0) / tot24;
      var projShare = projShares[par] || 0;
      var ratio     = baseShare > 0 ? projShare / baseShare : 1;
      newVotes[par] = Math.round((p24.votes[par] || 0) * ratio);
    });
    var newEm = Math.round((p24.emitidos || 0) * scale);
    out[id] = Object.assign({}, p24, {
      votes:    newVotes,
      emitidos: newEm,
      validos:  Math.round(newEm * 0.985),
      inscritos: p24.inscritos ? Math.round(p24.inscritos * (padron.total / padron.total2024)) : null,
    });
  });
  return out;
}

function _scaleCircVotes(circ24, baseNatVotes, projShares, em24, em2028) {
  var out = {};
  var scale = em24 > 0 ? em2028 / em24 : 1;
  var tot24 = Object.values(baseNatVotes).reduce(function(a, v) { return a + v; }, 0) || 1;

  Object.entries(circ24).forEach(function(e) {
    var id   = e[0];
    var c24  = e[1];
    var newVotes = {};
    Object.keys(c24.votes || {}).forEach(function(par) {
      var baseShare = (baseNatVotes[par] || 0) / tot24;
      var projShare = projShares[par] || 0;
      var ratio     = baseShare > 0 ? projShare / baseShare : 1;
      newVotes[par] = Math.round((c24.votes[par] || 0) * ratio);
    });
    out[id] = Object.assign({}, c24, {
      votes: newVotes,
      meta: Object.assign({}, c24.meta, {
        emitidos: Math.round((c24.meta && c24.meta.emitidos || 0) * scale),
      }),
    });
  });
  return out;
}

function _scaleProvFromNat(prov, baseNatVotes, simNatVotes, emNivel) {
  var out    = {};
  var baseTot = Object.values(baseNatVotes).reduce(function(a, v) { return a + v; }, 0) || 1;
  var simTot  = Object.values(simNatVotes).reduce(function(a, v) { return a + v; }, 0) || 1;

  Object.entries(prov).forEach(function(e) {
    var id   = e[0];
    var terr = e[1];
    var newVotes = {};
    Object.keys(terr.votes || {}).forEach(function(par) {
      var baseS = (baseNatVotes[par] || 0) / baseTot;
      var simS  = (simNatVotes[par]  || 0) / simTot;
      var ratio = baseS > 0 ? simS / baseS : 1;
      newVotes[par] = Math.round((terr.votes[par] || 0) * ratio);
    });
    out[id] = Object.assign({}, terr, { votes: newVotes });
  });
  return out;
}
