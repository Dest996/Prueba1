// Native Gemini API: audio and text stay with the selected provider.
async function requestGemini(path, payload) {
  if (!process.env.GEMINI_API_KEY?.trim()) throw new Error('Falta configurar Gemini. Ejecuta npm run configurar -- gemini y reinicia Hilo.');
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${path}`, {
      method: payload ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(120000),
    });
  } catch { throw new Error('No se pudo contactar con Gemini. Revisa tu conexión a Internet.'); }
  if (!response.ok) {
    let error;
    try { error = (await response.json()).error; } catch {}
    if (response.status === 401 || error?.details?.some(d => d.reason === 'API_KEY_INVALID')) throw new Error('Gemini rechazó la clave. Ejecuta npm run configurar -- gemini con una clave válida y reinicia Hilo.');
    if (response.status === 429) throw new Error('Gemini alcanzó una cuota o un límite de solicitudes. Revisa los límites gratuitos de tu proyecto en Google AI Studio y espera antes de reintentar. No se cambiará a otro proveedor automáticamente.');
    if ([403, 404].includes(response.status)) throw new Error('Gemini no permite acceder al modelo. Revisa la disponibilidad en tu región, los permisos de la clave y GEMINI_MODEL en .env.');
    throw new Error(`Gemini no pudo completar la operación (HTTP ${response.status}). Revisa la configuración y vuelve a intentarlo.`);
  }
  return response.json();
}

let discoveredModel;
async function resolveModel() {
  if (process.env.GEMINI_MODEL) {
    if (!/^[a-zA-Z0-9._-]+$/.test(process.env.GEMINI_MODEL)) throw new Error('El nombre de GEMINI_MODEL no es válido.');
    return process.env.GEMINI_MODEL;
  }
  if (discoveredModel) return discoveredModel;
  const models = [];
  let token;
  for (let page = 0; page < 10; page++) {
    const list = await requestGemini(`models?pageSize=1000${token ? '&pageToken=' + encodeURIComponent(token) : ''}`);
    models.push(...(list.models || []));
    token = list.nextPageToken;
    if (!token) break;
  }
  const supported = models.filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
  const stable = supported.map(name => ({name, match: name.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?(?:-\d+)?$/)})).filter(m => m.match);
  stable.sort((a,b) => Number(Boolean(b.match[2])) - Number(Boolean(a.match[2])) || Number(b.match[1]) - Number(a.match[1]));
  discoveredModel = stable[0]?.name || ['gemini-flash-lite-latest','gemini-flash-latest'].find(name => supported.includes(name));
  if (!discoveredModel) throw new Error('No se encontró un modelo Gemini Flash compatible. Revisa los modelos y la cuota gratuita en AI Studio y configura GEMINI_MODEL en .env.');
  return discoveredModel;
}

export async function generateGemini(parts, system, schema) {
  const model = await resolveModel();
  const result = await requestGemini(`models/${model}:generateContent`, { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', responseSchema: googleSchema(schema) } });
  const candidate = result.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw new Error('Gemini no pudo completar el contenido. Prueba con una nota más breve o clasifícala manualmente.');
  const text = candidate?.content?.parts?.map(p => p.text || '').join('');
  if (!text) throw new Error('Gemini no devolvió contenido utilizable. Puedes organizar la nota manualmente.');
  try { return JSON.parse(text); }
  catch { throw new Error('Gemini devolvió una respuesta incompleta. Vuelve a intentarlo.'); }
}
function googleSchema(schema) {
  // Gemini's OpenAPI schema uses nullable rather than JSON Schema union types.
  const { additionalProperties, ...result } = schema;
  if (Array.isArray(result.type)) { result.type = result.type.find(t => t !== 'null'); result.nullable = true; }
  if (result.type) result.type = result.type.toUpperCase();
  if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties).map(([k,v]) => [k,googleSchema(v)]));
  if (result.items) result.items = googleSchema(result.items);
  return result;
}
