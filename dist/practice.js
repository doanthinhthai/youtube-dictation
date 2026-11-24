export const defaultShortcuts={toggle:'Alt+Space',replay:'Alt+KeyR',previous:'Alt+ArrowLeft',next:'Alt+ArrowRight'};
export const shortcutLabels={toggle:'Phát / tạm dừng',replay:'Nghe lại câu',previous:'Câu trước',next:'Câu tiếp theo'};
export function submissionAction(answer,text=answer.text){return answer.checks>0&&typeof answer.checkedText==='string'&&answer.checkedText===text?'next':'check';}
export function keyCombo(event){if(['Control','Alt','Shift','Meta'].includes(event.key))return null;return [event.ctrlKey?'Ctrl':null,event.altKey?'Alt':null,event.shiftKey?'Shift':null,event.metaKey?'Meta':null,event.code].filter(Boolean).join('+');}
export function displayCombo(combo){return combo.split('+').map(v=>v.replace(/^Key/,'').replace(/^Digit/,'').replace('ArrowLeft','←').replace('ArrowRight','→')).join(' + ');}
export function validShortcut(combo){return /^(?:(?:Ctrl|Alt|Shift|Meta)\+)+(?:Key[A-Z]|Digit\d|Space|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(combo)&&combo.split('+').some(k=>['Ctrl','Alt','Meta'].includes(k))&&!['Ctrl+KeyR','Ctrl+KeyW','Ctrl+KeyL'].includes(combo);}
export function segmentBounds(segment,duration,settings,range=null){const max=Number.isFinite(duration)?duration:Infinity;const a=range?.start??Math.max(0,segment.start-(+settings.leadIn||0));const b=range?.end??segment.end+(+settings.tailOut||0);return {start:Math.min(Math.max(0,a),max),end:Math.min(b,max)};}
/** One cancellable playback chain. Timers are injected for deterministic tests. */
export class SegmentPlayer {
  constructor(media,{onState=()=>{},schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id)}={}){this.media=media;this.onState=onState;this.schedule=schedule;this.cancel=cancel;this.timer=null;this.generation=0;this.active=false;}
  stop(){this.generation++;this.cancel(this.timer);this.timer=null;this.active=false;this.media.pause();this.onState({state:'idle'});}
  async play({start,end,repeats=1,gap=1,speed=1,resume=false}){
    if(!(Number.isFinite(start)&&Number.isFinite(end)&&end>start))throw new Error('Đoạn nghe cần có mốc bắt đầu nhỏ hơn kết thúc.');
    this.stop();const token=this.generation;this.active=true;let completed=0;const media=this.media;
    const current=()=>token===this.generation;
    const pass=async(first=false)=>{
      if(!current())return;this.cancel(this.timer);media.playbackRate=speed;
      if(!first||!resume||media.currentTime<start||media.currentTime>=end)media.currentTime=start;
      try{await media.play();}catch(error){if(current()){this.stop();this.onState({state:'error',error});}return;}
      if(!current())return;this.onState({state:'playing',pass:completed+1,total:repeats});
      const tick=()=>{
        if(!current())return;
        if(media.currentTime>=end||media.ended){media.pause();completed++;if(repeats&&completed>=repeats){this.active=false;this.timer=null;this.onState({state:'done',pass:completed,total:repeats});return;}
          const until=Date.now()+gap*1000;
          const wait=()=>{if(!current())return;const remaining=Math.max(0,(until-Date.now())/1000);this.onState({state:'gap',pass:completed,total:repeats,remaining});if(remaining<=0){pass();return;}this.timer=this.schedule(wait,Math.min(100,remaining*1000));};wait();return;
        }
        this.timer=this.schedule(tick,Math.max(5,Math.min(25,(end-media.currentTime)/media.playbackRate*1000)));
      };tick();
    };await pass(true);
  }
}
