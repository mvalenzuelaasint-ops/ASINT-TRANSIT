/**
 * Fase 1: cálculo de flota planificada a partir de GTFS Schedule (sin Real Time).
 *
 * Flujo en dos pasos (evita ejecutar heuristica_POs_USs_2026.py sobre rutas que
 * el usuario no pidió, ver notes/CLAUDE.md):
 *   POST /preview -> sube el .zip, solo hace ETL (matriz "inputurística" completa
 *                     + mapa GeoJSON + lista de servicios). No corre la heurística.
 *   POST /run     -> JSON { runId, seleccion }, reusa la matriz de /preview (mismo
 *                     runId) y corre heuristica_POs_USs_2026.py solo para la
 *                     selección ('TODAS' o un unidadServicio puntual).
 */
import { Router } from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH =
  process.env.ASINT_TRIPY_SCRIPT || path.join(BACKEND_ROOT, 'scripts', 'gtfs_to_tripy_headless.py');
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const RUNS_ROOT = path.join(BACKEND_ROOT, 'runs', 'tripy');

const PYTHON_CMD =
  process.env.ASINT_PYTHON_CMD ||
  (process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || '', 'anaconda3', 'python.exe')
    : 'python3');

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        const runId = randomUUID();
        const runDir = path.join(RUNS_ROOT, runId);
        await mkdir(path.join(runDir, 'input'), { recursive: true });
        await mkdir(path.join(runDir, 'output'), { recursive: true });
        req.runId = runId;
        req.runDir = runDir;
        cb(null, path.join(runDir, 'input'));
      } catch (err) {
        cb(err, '');
      }
    },
    filename: (_req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const router = Router();

router.get('/status', (_req, res) => {
  res.json({ pythonCmd: PYTHON_CMD, scriptPath: SCRIPT_PATH, runsRoot: RUNS_ROOT });
});

router.post('/preview', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Falta el archivo GTFS (campo "file").' });
  }

  const runId = req.runId;
  const outputDir = path.join(req.runDir, 'output');
  const env = {
    ...process.env,
    ASINT_HEADLESS: '1',
    ASINT_TRIPY_ACCION: 'previsualizar',
    ASINT_INPUT_FILE: req.file.path,
    ASINT_OUTPUT_DIR: outputDir,
    PYTHONIOENCODING: 'utf-8',
  };

  runScript(env, outputDir, (result) => {
    res.status(result.success ? 200 : 500).json({ runId, inputFile: req.file.originalname, ...result });
  });
});

router.post('/run', async (req, res) => {
  const runId = sanitizeId(req.body?.runId);
  const seleccion = typeof req.body?.seleccion === 'string' && req.body.seleccion.trim() ? req.body.seleccion.trim() : 'TODAS';
  if (!runId) {
    return res.status(400).json({ error: 'Falta "runId" (debe venir de una previsualización previa).' });
  }

  const runDir = path.join(RUNS_ROOT, runId);
  const outputDir = path.join(runDir, 'output');
  const inputuristicaPath = path.join(outputDir, 'inputuristica.xlsx');
  try {
    await access(inputuristicaPath);
  } catch {
    return res.status(404).json({
      error: 'No se encontró la matriz de una previsualización para ese runId.',
      detail: 'Corre POST /preview primero (no expira, pero cada preview genera un runId nuevo).',
    });
  }

  const env = {
    ...process.env,
    ASINT_HEADLESS: '1',
    ASINT_TRIPY_ACCION: 'ejecutar',
    ASINT_INPUT_FILE: inputuristicaPath,
    ASINT_OUTPUT_DIR: outputDir,
    ASINT_UNIDADES: seleccion,
    PYTHONIOENCODING: 'utf-8',
    // Mismos parámetros forzados que usa /api/heuristic/run (ver heuristic.js).
    ASINT_HORAS_BLOQUE: '144',
    ASINT_HORA_INICIO_BLOQUE: '0',
    ASINT_LIMITE_EXPEDICION: '1000',
    ASINT_PASO_MINUTOS: '5',
  };

  runScript(env, outputDir, (result) => {
    res.status(result.success ? 200 : 500).json({ runId, seleccion, ...result });
  });
});

function runScript(env, outputDir, callback) {
  const startedAt = Date.now();
  const child = spawn(PYTHON_CMD, ['-X', 'utf8', SCRIPT_PATH], { cwd: SCRIPT_DIR, env });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  child.on('error', (err) => {
    callback({ success: false, error: 'No se pudo iniciar Python.', detail: err.message, pythonCmd: PYTHON_CMD });
  });

  child.on('close', async (code) => {
    const durationMs = Date.now() - startedAt;
    if (code !== 0) {
      callback({
        success: false,
        exitCode: code,
        durationMs,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
      });
      return;
    }
    try {
      const files = await listOutputFiles(outputDir);
      callback({ success: true, exitCode: code, durationMs, files, stdoutTail: stdout.slice(-1500) });
    } catch (err) {
      callback({ success: false, error: 'No se pudo leer la carpeta de output.', detail: err.message });
    }
  });
}

router.get('/runs/:runId/files', async (req, res) => {
  const runId = sanitizeId(req.params.runId);
  if (!runId) return res.status(400).json({ error: 'runId invalido' });
  try {
    const files = await listOutputFiles(path.join(RUNS_ROOT, runId, 'output'));
    res.json({ runId, files });
  } catch (err) {
    res.status(404).json({ error: 'Run no encontrado.', detail: err.message });
  }
});

router.get('/runs/:runId/file', (req, res) => {
  const runId = sanitizeId(req.params.runId);
  const relPath = String(req.query.path || '');
  if (!runId || !relPath) return res.status(400).json({ error: 'parametros invalidos' });

  const outputDir = path.join(RUNS_ROOT, runId, 'output');
  const resolved = path.resolve(outputDir, relPath);
  if (!resolved.startsWith(outputDir + path.sep) && resolved !== outputDir) {
    return res.status(400).json({ error: 'ruta fuera del run' });
  }
  res.sendFile(resolved, (err) => {
    if (err) res.status(404).end();
  });
});

async function listOutputFiles(dir) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const s = await stat(full);
        out.push({
          name: path.relative(dir, full).replaceAll('\\', '/'),
          size: s.size,
          modified: s.mtime.toISOString(),
          ext: path.extname(entry.name).toLowerCase(),
        });
      }
    }
  }
  await walk(dir);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function sanitizeId(id) {
  return typeof id === 'string' && /^[0-9a-fA-F-]{36}$/.test(id) ? id : null;
}

export default router;
