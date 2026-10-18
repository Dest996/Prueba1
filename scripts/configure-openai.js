import { readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function setApiKey(contents, key) {
  // Permit the current OpenAI key alphabet, but never newlines or dotenv syntax.
  if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(key)) throw new Error('La clave debe comenzar por sk- y no contener espacios.');
  const lines = contents.replace(/\r\n/g, '\n').split('\n');
  let replaced = false;
  const updated = lines.filter(line => {
    if (!/^\s*(?:export\s+)?OPENAI_API_KEY\s*=/.test(line)) return true;
    if (replaced) return false;
    replaced = true;
    return true;
  }).map(line => /^\s*(?:export\s+)?OPENAI_API_KEY\s*=/.test(line) ? `OPENAI_API_KEY=${key}` : line);
  if (!replaced) updated.push(`OPENAI_API_KEY=${key}`);
  return updated.join('\n').replace(/\n*$/, '\n');
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Abre cmd en la carpeta del proyecto y ejecuta npm run configurar de forma interactiva.');
  console.log('\nConectar Hilo con OpenAI\n');
  console.log('1. Crea una clave en https://platform.openai.com/api-keys');
  console.log('2. Activa la facturación de API en tu cuenta. ChatGPT y la API se facturan por separado.');
  console.log('La clave se guardará solo en .env, que está excluido de Git. No la compartas en el chat.\n');
  if (existsSync('.env') && !lstatSync('.env').isFile()) throw new Error('.env debe ser un archivo local normal.');
  const original = existsSync('.env') ? readFileSync('.env', 'utf8') : readFileSync('.env.example', 'utf8');
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback(); } });
  output.isTTY = true;
  output.columns = process.stdout.columns;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  let key;
  try {
    process.stdout.write('Pega tu clave y pulsa Enter (el texto permanecerá oculto): ');
    hidden = true;
    key = (await rl.question('')).trim();
  } finally { hidden = false; rl.close(); process.stdout.write('\n'); }
  if (!key) { console.log('Cancelado. No se modificó la configuración.'); return; }
  writeFileSync('.env', setApiKey(original, key), { mode: 0o600 });
  console.log('Clave guardada. Ejecuta npm start (o reinícialo) y pulsa Comprobar OpenAI en el dashboard.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
