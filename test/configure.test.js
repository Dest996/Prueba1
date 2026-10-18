import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseEnv} from 'node:util';
import {setApiKey} from '../scripts/configure-openai.js';

test('setup replaces duplicate API keys while preserving unrelated configuration',()=>{
  const previous='PORT=4567\r\nWHATSAPP_ACCESS_TOKEN=keep-local\r\nexport OPENAI_API_KEY=old\r\nOPENAI_API_KEY=duplicate\r\n# comentario\r\n';
  const result=setApiKey(previous,'sk-example-for-testing-only');
  const parsed=parseEnv(result);
  assert.equal(parsed.OPENAI_API_KEY,'sk-example-for-testing-only');
  assert.equal(parsed.PORT,'4567');assert.equal(parsed.WHATSAPP_ACCESS_TOKEN,'keep-local');
  assert.equal(result.match(/OPENAI_API_KEY=/g).length,1);assert.match(result,/# comentario/);
  assert.equal(setApiKey(result,'sk-example-for-testing-only'),result);
});
test('setup adds a missing API key and rejects dotenv injection',()=>{
  assert.equal(parseEnv(setApiKey('PORT=3000','sk-example-for-testing-only')).OPENAI_API_KEY,'sk-example-for-testing-only');
  for(const key of ['','invalid','sk-example\nPORT=1234','sk-example#comment'])assert.throws(()=>setApiKey('',key));
});

test('switching to Gemini preserves the OpenAI key but selects only Gemini',()=>{
  const original='AI_PROVIDER=openai\nOPENAI_API_KEY=sk-old-local-key\nPORT=4567\n';
  const updated=setApiKey(original,'AIzaExampleKeyForTestingOnly123456','gemini');
  const parsed=parseEnv(updated);
  assert.equal(parsed.AI_PROVIDER,'gemini');assert.equal(parsed.GEMINI_API_KEY,'AIzaExampleKeyForTestingOnly123456');assert.equal(parsed.OPENAI_API_KEY,'sk-old-local-key');assert.equal(parsed.PORT,'4567');
  assert.equal(setApiKey(updated,'AIzaExampleKeyForTestingOnly123456','gemini'),updated);
  assert.throws(()=>setApiKey(original,'key\nPORT=1234','gemini'));
});
