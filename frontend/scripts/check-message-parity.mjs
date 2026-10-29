import { readFileSync } from 'node:fs';

const en = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'));
const es = JSON.parse(readFileSync(new URL('../messages/es.json', import.meta.url), 'utf8'));

function keys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object' && !Array.isArray(child)
      ? keys(child, path)
      : [path];
  }).sort();
}

const enKeys = keys(en);
const esKeys = keys(es);
const missingInEs = enKeys.filter((key) => !esKeys.includes(key));
const missingInEn = esKeys.filter((key) => !enKeys.includes(key));
if (missingInEs.length || missingInEn.length) {
  console.error('Translation message keys differ.');
  if (missingInEs.length) console.error(`Missing in es.json: ${missingInEs.join(', ')}`);
  if (missingInEn.length) console.error(`Missing in en.json: ${missingInEn.join(', ')}`);
  process.exitCode = 1;
}
