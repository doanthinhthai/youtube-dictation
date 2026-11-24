export const escapeHTML = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function tokens(text) {
  const normalized=String(text).toLowerCase().normalize('NFKC').replace(/[’‘]/g,"'")
    .replace(/\bwon't\b/g,'will not').replace(/\bcan't\b/g,'can not').replace(/\bshan't\b/g,'shall not')
    .replace(/n't\b/g,' not').replace(/\bi'm\b/g,'i am').replace(/\b(let)'s\b/g,'$1 us')
    .replace(/\b(he|she|it|that|there|what|who)'s\b/g,'$1 is').replace(/'re\b/g,' are').replace(/'ve\b/g,' have').replace(/'ll\b/g,' will').replace(/'d\b/g,' would');
  return normalized.match(/[a-z0-9]+(?:'[a-z]+)?/g)||[];
}
export function compare(expected, actual) {
  const a=tokens(expected),b=tokens(actual);const d=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++)d[i][0]=i;for(let j=0;j<=b.length;j++)d[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  let i=a.length,j=b.length;const diff=[];
  while(i||j) {if(i&&j&&d[i][j]===d[i-1][j-1]+(a[i-1]===b[j-1]?0:1)) {diff.push({type:a[i-1]===b[j-1]?'correct':'replace',expected:a[--i],actual:b[--j]});}else if(i&&d[i][j]===d[i-1][j]+1) {diff.push({type:'missing',expected:a[--i]});}else{diff.push({type:'extra',actual:b[--j]});}}
  return {score:Math.max(0,Math.round((1-d[a.length][b.length]/Math.max(a.length,b.length,1))*100)),diff:diff.reverse(),errors:d[a.length][b.length]};
}
export function parseTime(value) {
  const parts=String(value).trim().replace(',','.').split(':').map(Number);
  if(parts.length>3||parts.some(n=>!Number.isFinite(n)||n<0)) throw new Error('Mốc thời gian không hợp lệ: '+value);
  return parts.reduce((s,n)=>s*60+n,0);
}
export function parseSubtitles(text) {
  const result=[]; const lines=String(text).replace(/^\uFEFF/,'').replace(/\r/g,'').split('\n');
  for(let i=0;i<lines.length;i++) {
    const match=lines[i].match(/((?:\d+:)?\d{1,2}:\d{2}[.,]\d+)\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d+)/);
    if(!match)continue; const start=parseTime(match[1]),end=parseTime(match[2]);let content=[];
    while(i+1<lines.length&&lines[i+1].trim()&&!lines[i+1].includes('-->'))content.push(lines[++i]);
    const value=content.join(' ').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim();
    if(value&&end>start)result.push({start,end,text:value,translation:''});
  }
  if(!result.length)throw new Error('Không đọc được phụ đề. Chọn file SRT hoặc VTT có mốc thời gian.');
  return result;
}
export function formatTime(seconds=0) {return Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');}
export function dayKey(date=new Date()) {return new Date(date).toLocaleDateString('en-CA');}
