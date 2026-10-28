import { readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function setApiKey(contents, key, provider = 'openai') {
  if (!['openai','gemini'].includes(provider)) throw new Error('El proveedor debe ser openai o gemini.');
  // Google keys may contain dots. This only checks safe dotenv characters;
  // the provider's response determines whether the credential is valid.
  if (provider === 'openai' ? !/^sk-[A-Za-z0-9_-]{10,}$/.test(key) : !/^[A-Za-z0-9._-]{20,}$/.test(key)) throw new Error('La clave no tiene el formato esperado o contiene espacios.');
  function setVariable(text, name, value) {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
    let found = false;
    const updated = [];
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
      if (pattern.test(line)) {
        if (!found) updated.push(`${name}=${value}`);
        found = true;
      } else updated.push(line);
    }
    if (!found) updated.push(`${name}=${value}`);
    return updated.join('\n').replace(/\n*$/, '\n');
  }
  const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
  return setVariable(setVariable(contents, keyName, key), 'AI_PROVIDER', provider);
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Abre cmd en la carpeta del proyecto y ejecuta npm run configurar de forma interactiva.');
  const provider = process.argv[2] || 'openai';
  if (!['openai','gemini'].includes(provider)) throw new Error('Usa npm run configurar -- gemini o npm run configurar -- openai.');
  console.log(`\nConectar AL DÍA con ${provider === 'gemini' ? 'Gemini' : 'OpenAI'}\n`);
  if (provider === 'gemini') {
    console.log('1. Crea una clave en https://aistudio.google.com/apikey');
    console.log('2. Comprueba en AI Studio que tu proyecto y modelo tienen cuota gratuita disponible. No actives facturación si deseas limitarte al nivel gratuito.');
    console.log('En el nivel gratuito, Google puede usar los datos para mejorar sus productos. Evita información laboral sensible.');
  } else {
    console.log('1. Crea una clave en https://platform.openai.com/api-keys');
    console.log('2. Activa la facturación de API en tu cuenta. ChatGPT y la API se facturan por separado.');
  }
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
  writeFileSync('.env', setApiKey(original, key, provider), { mode: 0o600 });
  console.log('Clave guardada. Ejecuta npm start (o reinícialo) y pulsa Comprobar IA en el dashboard.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
