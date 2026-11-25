import { tokens } from './core.js';

export function scoreWhole(expected, actual) {
  const a = tokens(expected);
  const b = tokens(actual);
  const total = Math.max(a.length, b.length, 1);
  let first = 0;
  let aEnd = a.length;
  let bEnd = b.length;
  while (first < aEnd && first < bEnd && a[first] === b[first]) first++;
  while (aEnd > first && bEnd > first && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd--; }
  let input = a.slice(first, aEnd);
  let output = b.slice(first, bEnd);
  if (input.length < output.length) [input, output] = [output, input];
  if (input.length * output.length > 150000000) {
    throw new Error('Lời chép rất dài. Hãy thêm mốc để chấm theo từng câu.');
  }
  const distance = new Uint32Array(output.length + 1);
  for (let j = 0; j < distance.length; j++) distance[j] = j;
  for (let i = 1; i <= input.length; i++) {
    let diagonal = distance[0];
    distance[0] = i;
    for (let j = 1; j < distance.length; j++) {
      const above = distance[j];
      distance[j] = input[i - 1] === output[j - 1] ? diagonal :
        Math.min(diagonal, distance[j - 1], above) + 1;
      diagonal = above;
    }
  }
  return Math.max(0, Math.round((1 - distance[output.length] / total) * 100));
}

export async function scoreWholeInBackground(expected, actual) {
  if (typeof Worker !== 'function' || expected.length * actual.length < 20000000) {
    return scoreWhole(expected, actual);
  }
  const worker = new Worker(new URL('./whole-score.js', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.score);
      worker.onerror = () => reject(new Error('Chưa chấm được bài. Hãy thử lại.'));
      worker.postMessage({ expected, actual });
    });
  } finally {
    worker.terminate();
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = ({ data }) => {
    try { globalThis.postMessage({ score: scoreWhole(data.expected, data.actual) }); }
    catch (error) { globalThis.postMessage({ error: error.message }); }
  };
}
