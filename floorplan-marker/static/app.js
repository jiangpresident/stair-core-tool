/* Floorplan Marker: no dependencies, network access restricted to the local server.
 * Annotation coordinates are always in original image pixels. Display zoom never
 * changes geometry. Automatic suggestions and manual annotations share a schema.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const colors = {walls:'#f04444', doors:'#ffc400', stairs:'#00be55'};
  const labels = {walls:'墙体', doors:'门洞', stairs:'楼梯间'};
  const state = {
    image:null, imageData:null, name:'floorplan', width:0, height:0, revision:0,
    walls:[], doors:[], stairs:[], selected:null, tool:'select', draft:[], pointer:null,
    view:{x:0,y:0,zoom:1}, viewport:{width:1,height:1}, drag:null, space:false,
    undo:[], redo:[], dirty:false, busy:false, meta:null,
    visible:{walls:true,doors:true,stairs:true}, detectToken:0
  };
  let uid = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
  const newId = prefix => `${prefix}:${Date.now().toString(36)}:${++uid}`;
  const snapshot = () => clone({walls:state.walls,doors:state.doors,stairs:state.stairs});
  function status(message,error=false) {
    $('status').textContent = message;
    $('status').classList.toggle('error',error);
    $('status').title = message;
  }
  function record(before) {
    state.undo.push(before);
    if(state.undo.length>60) state.undo.shift();
    state.redo=[];
    state.dirty=true;
    refresh();
  }
  function undo() {
    if(!state.undo.length)return;
    state.redo.push(snapshot());
    Object.assign(state,state.undo.pop());
    state.selected=null; state.draft=[]; state.dirty=true; refresh();
    status('已撤销上一步。');
  }
  function redo() {
    if(!state.redo.length)return;
    state.undo.push(snapshot());
    Object.assign(state,state.redo.pop());
    state.selected=null; state.draft=[]; state.dirty=true; refresh();
    status('已重做。');
  }
  function selectedShape() {
    return state.selected && state[state.selected.type].find(s=>s.id===state.selected.id);
  }
  const pointsOf = (shape,type) => type==='stairs'?shape.points:[[shape.x1,shape.y1],[shape.x2,shape.y2]];
  function setPoints(shape,type,points) {
    if(type==='stairs')shape.points=points;
    else [shape.x1,shape.y1,shape.x2,shape.y2]=points.flat();
  }
  function updateSelectionInfo() {
    const node=$('selection-info'),shape=selectedShape();
    node.replaceChildren();
    if(!shape){node.textContent='点击画布上的标注，查看类型与坐标。';return;}
    const title=document.createElement('strong');
    title.textContent=labels[state.selected.type];node.append(title,document.createElement('br'));
    const source=document.createElement('span');
    source.textContent=shape.source==='manual'?'手动标注 / 已调整':'自动候选 / 待核对';
    node.append(source,document.createElement('br'));
    pointsOf(shape,state.selected.type).forEach((point,i)=>{
      const row=document.createElement('div');row.className='coordinate';
      row.textContent=`${i+1}. (${point[0].toFixed(1)}, ${point[1].toFixed(1)}) px`;node.append(row);
    });
  }
  function refresh() {
    $('empty-state').hidden=!!state.image;
    $('wall-count').textContent=state.walls.length;
    $('door-count').textContent=state.doors.length;
    $('stair-count').textContent=state.stairs.length;
    $('annotation-total').textContent=`${state.walls.length+state.doors.length+state.stairs.length} 个标注`;
    $('undo-button').disabled=!state.undo.length;
    $('redo-button').disabled=!state.redo.length;
    $('delete-button').disabled=!selectedShape();
    $('detect-button').disabled=!state.image || state.busy;
    $('detect-button').textContent=state.busy?'正在分析图纸…':'开始自动识别';
    for(const id of ['export-png','export-svg','export-project']) $(id).disabled=!state.image;
    updateSelectionInfo();draw();
  }
  function screenToImage(event,limit=true) {
    const r=canvas.getBoundingClientRect();
    let x=(event.clientX-r.left-state.view.x)/state.view.zoom;
    let y=(event.clientY-r.top-state.view.y)/state.view.zoom;
    if(limit){x=clamp(x,0,state.width);y=clamp(y,0,state.height);}
    return [x,y];
  }
  const inImage = p => p[0]>=0&&p[0]<=state.width&&p[1]>=0&&p[1]<=state.height;
  function lineWidth(){return clamp(Math.min(state.width,state.height)*.004,2,8);}
  function drawShape(context,shape,type,zoom=1,selected=false) {
    context.save(); context.lineCap='round';context.lineJoin='round';
    const points=pointsOf(shape,type);
    context.beginPath();context.moveTo(...points[0]);
    points.slice(1).forEach(p=>context.lineTo(...p));
    if(type==='stairs'){
      context.closePath();context.fillStyle='rgba(0,190,85,0.5)';context.fill();
      // Fill alpha is exactly 0.5. The outline is a separate opaque stroke.
      context.strokeStyle=colors.stairs;context.lineWidth=Math.max(1.5,lineWidth()*.5);context.stroke();
    }else{context.strokeStyle=colors[type];context.lineWidth=lineWidth();context.stroke();}
    if(selected){
      context.strokeStyle='#13462f';context.lineWidth=1.5/zoom;
      context.setLineDash([5/zoom,4/zoom]);context.stroke();context.setLineDash([]);
      for(const p of points){
        context.beginPath();context.arc(...p,4.7/zoom,0,Math.PI*2);
        context.fillStyle='#fff';context.fill();context.strokeStyle='#225a3c';context.lineWidth=1.7/zoom;context.stroke();
      }
    }
    context.restore();
  }
  function draw() {
    const dpr=window.devicePixelRatio||1;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,state.viewport.width,state.viewport.height);
    if(!state.image)return;
    const {x,y,zoom}=state.view;
    ctx.translate(x,y);ctx.scale(zoom,zoom);
    ctx.save();ctx.shadowColor='#223b2325';ctx.shadowBlur=18/zoom;ctx.fillStyle='#fff';ctx.fillRect(0,0,state.width,state.height);ctx.restore();
    ctx.drawImage(state.image,0,0,state.width,state.height);
    // Areas below lines; doors above walls so an opening stays legible.
    for(const type of ['stairs','walls','doors']) {
      if(!state.visible[type])continue;
      for(const shape of state[type])drawShape(ctx,shape,type,zoom,false);
    }
    const selected=selectedShape();
    if(selected&&state.visible[state.selected.type]) {
      // Selection marks only; do not repaint translucent areas.
      const points=pointsOf(selected,state.selected.type);
      ctx.save();ctx.beginPath();ctx.moveTo(...points[0]);points.slice(1).forEach(p=>ctx.lineTo(...p));
      if(state.selected.type==='stairs')ctx.closePath();
      ctx.strokeStyle='#174e34';ctx.lineWidth=1.5/zoom;ctx.setLineDash([5/zoom,4/zoom]);ctx.stroke();ctx.setLineDash([]);
      points.forEach(p=>{ctx.beginPath();ctx.arc(...p,4.7/zoom,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.strokeStyle='#225a3c';ctx.lineWidth=1.7/zoom;ctx.stroke();});ctx.restore();
    }
    if(state.draft.length) {
      const points=[...state.draft];if(state.pointer)points.push(state.pointer);
      ctx.save();ctx.strokeStyle=colors[state.tool==='wall'?'walls':state.tool==='door'?'doors':'stairs'];
      ctx.lineWidth=lineWidth();ctx.setLineDash([7/zoom,4/zoom]);
      ctx.beginPath();ctx.moveTo(...points[0]);points.slice(1).forEach(p=>ctx.lineTo(...p));
      if(state.tool==='stairs'&&points.length>2){ctx.closePath();ctx.fillStyle='rgba(0,190,85,0.2)';ctx.fill();}
      ctx.stroke();ctx.setLineDash([]);state.draft.forEach(p=>{ctx.beginPath();ctx.arc(...p,3.5/zoom,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.stroke();});ctx.restore();
    }
    $('zoom-level').textContent=`${Math.round(zoom*100)}%`;
  }
  function resize(){
    const box=$('canvas-container').getBoundingClientRect(),dpr=window.devicePixelRatio||1;
    state.viewport={width:box.width,height:box.height};
    canvas.width=Math.max(1,Math.round(box.width*dpr));canvas.height=Math.max(1,Math.round(box.height*dpr));draw();
  }
  function fit(){
    if(!state.image)return;
    const zoom=clamp(Math.min((state.viewport.width-60)/state.width,(state.viewport.height-90)/state.height),.02,16);
    state.view={zoom,x:(state.viewport.width-state.width*zoom)/2,y:(state.viewport.height-state.height*zoom)/2-10};draw();
  }
  function zoomAt(factor,x=state.viewport.width/2,y=state.viewport.height/2){
    if(!state.image)return;
    const old=state.view.zoom,next=clamp(old*factor,.02,16);
    state.view.x=x-(x-state.view.x)*next/old;state.view.y=y-(y-state.view.y)*next/old;state.view.zoom=next;draw();
  }
  function tool(name){
    state.tool=name;state.draft=[];state.pointer=null;
    document.querySelectorAll('[data-tool]').forEach(button=>{const active=button.dataset.tool===name;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    $('tool-hint').textContent={select:'点击选择；拖动端点或顶点修正，拖动图形整体移动。',wall:'点击墙线起点、终点。Shift 锁定水平或竖直；Esc 取消。',door:'在门洞两端点击，绘制闭合位置的黄色线段。',stairs:'点击楼梯间边界顶点，Enter / 双击 / 点击首点完成。'}[name];
    canvas.style.cursor=name==='select'?'default':'crosshair';draw();
  }
  function distanceToSegment(p,a,b){
    const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy;
    const t=den?clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den,0,1):0;
    return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
  }
  function insidePolygon(p,points){
    let inside=false;
    for(let i=0,j=points.length-1;i<points.length;j=i++){
      const a=points[i],b=points[j];
      if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    }
    return inside;
  }
  function hitTest(p){
    const tolerance=8/state.view.zoom,selected=selectedShape();
    if(selected&&state.visible[state.selected.type]){
      const vertex=pointsOf(selected,state.selected.type).findIndex(v=>Math.hypot(v[0]-p[0],v[1]-p[1])<=tolerance);
      if(vertex>=0)return {...state.selected,vertex};
    }
    for(const type of ['doors','walls','stairs']){
      if(!state.visible[type])continue;
      for(const shape of [...state[type]].reverse()){
        const points=pointsOf(shape,type);
        const count=type==='stairs'?points.length:1;
        for(let i=0;i<count;i++)if(distanceToSegment(p,points[i],points[(i+1)%points.length])<=tolerance)return {type,id:shape.id,vertex:-1};
        if(type==='stairs'&&insidePolygon(p,points))return {type,id:shape.id,vertex:-1};
      }
    }
    return null;
  }
  function snapPoint(p,event){
    if(event.shiftKey&&state.draft.length){const a=state.draft[state.draft.length-1];return Math.abs(p[0]-a[0])>Math.abs(p[1]-a[1])?[p[0],a[1]]:[a[0],p[1]];}
    return p;
  }
  function polygonArea(points){return Math.abs(points.reduce((s,p,i)=>{const q=points[(i+1)%points.length];return s+p[0]*q[1]-q[0]*p[1];},0)/2);}
  function finishPolygon(){
    if(state.tool!=='stairs'||state.draft.length<3){status('楼梯间至少需要 3 个不同的顶点。',true);return;}
    if(polygonArea(state.draft)<4){status('楼梯间范围太小，请调整顶点。',true);return;}
    const before=snapshot(),shape={id:newId('manual'),points:clone(state.draft),source:'manual'};
    state.stairs.push(shape);state.selected={type:'stairs',id:shape.id};state.draft=[];state.pointer=null;record(before);status('已添加楼梯间，绿色填充透明度为 50%。');
  }
  canvas.addEventListener('pointerdown',event=>{
    if(!state.image)return;
    canvas.focus({preventScroll:true});
    if(event.button===1||(event.button===0&&state.space)){
      event.preventDefault();canvas.setPointerCapture(event.pointerId);
      state.drag={mode:'pan',start:[event.clientX,event.clientY],view:{...state.view}};canvas.style.cursor='grabbing';return;
    }
    if(event.button!==0)return;
    const raw=screenToImage(event,false);if(!inImage(raw))return;
    let p=snapPoint(raw,event);
    if(state.tool==='select'){
      const hit=hitTest(p);state.selected=hit?{type:hit.type,id:hit.id}:null;
      if(hit){canvas.setPointerCapture(event.pointerId);state.drag={mode:'shape',hit,start:p,original:clone(selectedShape()),before:snapshot(),moved:false};}
      refresh();return;
    }
    if(state.tool==='stairs'){
      // The second click of a native double-click must not append a duplicate vertex.
      if(event.detail>=2)return;
      if(state.draft.length>=3&&Math.hypot(p[0]-state.draft[0][0],p[1]-state.draft[0][1])*state.view.zoom<9){finishPolygon();return;}
      const last=state.draft.at(-1);
      if(!last||Math.hypot(last[0]-p[0],last[1]-p[1])>1)state.draft.push(p);
      state.pointer=p;draw();return;
    }
    if(!state.draft.length){state.draft=[p];state.pointer=p;draw();return;}
    const a=state.draft[0];if(Math.hypot(a[0]-p[0],a[1]-p[1])<1){status('线段太短，请重新选择终点。',true);return;}
    const before=snapshot(),type=state.tool==='wall'?'walls':'doors';
    const shape={id:newId('manual'),x1:a[0],y1:a[1],x2:p[0],y2:p[1],source:'manual'};
    state[type].push(shape);state.selected={type,id:shape.id};state.draft=[];state.pointer=null;record(before);status(`已添加${labels[type]}标注。`);
  });
  canvas.addEventListener('pointermove',event=>{
    if(!state.image)return;
    if(state.drag?.mode==='pan'){
      state.view.x=state.drag.view.x+event.clientX-state.drag.start[0];state.view.y=state.drag.view.y+event.clientY-state.drag.start[1];draw();return;
    }
    const p=screenToImage(event);
    if(state.drag?.mode==='shape'){
      const {hit,start,original}=state.drag,shape=selectedShape();if(!shape)return;
      let points=clone(pointsOf(original,hit.type));
      if(hit.vertex>=0)points[hit.vertex]=p;
      else{
        const xs=points.map(v=>v[0]),ys=points.map(v=>v[1]);
        const dx=clamp(p[0]-start[0],-Math.min(...xs),state.width-Math.max(...xs));
        const dy=clamp(p[1]-start[1],-Math.min(...ys),state.height-Math.max(...ys));
        points=points.map(v=>[v[0]+dx,v[1]+dy]);
      }
      setPoints(shape,hit.type,points);state.drag.moved=JSON.stringify(points)!==JSON.stringify(pointsOf(original,hit.type));draw();updateSelectionInfo();return;
    }
    if(state.draft.length){state.pointer=snapPoint(p,event);draw();}
  });
  function endDrag(event,cancel=false){
    if(!state.drag)return;
    const drag=state.drag;state.drag=null;
    if(drag.mode==='shape'&&drag.moved){
      const shape=selectedShape();
      if(cancel){Object.assign(state,drag.before);}
      else if(shape){
        const valid=drag.hit.type==='stairs'?polygonArea(shape.points)>=.01:Math.hypot(shape.x2-shape.x1,shape.y2-shape.y1)>=.01;
        if(!valid){Object.assign(state,drag.before);status('该调整会使标注长度或面积为零，已恢复原位置。',true);}
        else{shape.source='manual';delete shape.confidence;record(drag.before);}
      }
    }
    if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor=state.tool==='select'?'default':'crosshair';refresh();
  }
  canvas.addEventListener('pointerup',event=>endDrag(event));
  canvas.addEventListener('pointercancel',event=>endDrag(event,true));
  canvas.addEventListener('dblclick',event=>{event.preventDefault();if(state.tool==='stairs'&&state.draft.length)finishPolygon();});
  canvas.addEventListener('wheel',event=>{if(!state.image)return;event.preventDefault();const r=canvas.getBoundingClientRect();zoomAt(Math.exp(-event.deltaY*.0015),event.clientX-r.left,event.clientY-r.top);},{passive:false});
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
  function deleteSelected(){
    if(!selectedShape())return;
    const before=snapshot(),{type,id}=state.selected;state[type]=state[type].filter(s=>s.id!==id);state.selected=null;record(before);status('已删除标注，可撤销。');
  }
  document.addEventListener('keydown',event=>{
    if($('help-dialog').open)return;
    const target=event.target;if(target instanceof HTMLElement&&(/INPUT|TEXTAREA|SELECT/.test(target.tagName)||target.isContentEditable))return;
    const key=event.key.toLowerCase();
    if((event.ctrlKey||event.metaKey)&&key==='z'){event.preventDefault();event.shiftKey?redo():undo();return;}
    if((event.ctrlKey||event.metaKey)&&key==='y'){event.preventDefault();redo();return;}
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    if(key===' '){if(state.image){event.preventDefault();state.space=true;canvas.style.cursor='grab';}return;}
    if(key==='escape'){state.draft=[];state.selected=null;state.pointer=null;tool('select');refresh();}
    if(key==='delete'||key==='backspace'){if(state.image)event.preventDefault();deleteSelected();}
    if(key==='enter'&&state.tool==='stairs'&&state.draft.length){event.preventDefault();finishPolygon();}
    const shortcut={v:'select',w:'wall',d:'door',s:'stairs'}[key];if(shortcut){event.preventDefault();tool(shortcut);}
  });
  document.addEventListener('keyup',event=>{if(event.key===' '){state.space=false;canvas.style.cursor=state.tool==='select'?'default':'crosshair';}});
  window.addEventListener('blur',()=>{state.space=false;});
  window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});

  // File loading and project validation.
  function fileToDataURL(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('无法读取文件。'));reader.readAsDataURL(file);});}
  function decodeImage(src){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('无法解码图片，请使用 PNG、JPG、WebP 或 BMP。'));image.src=src;});}
  function okayToReplace(){return !state.dirty||window.confirm('当前工程有未保存的改动。继续导入会清空当前工程，是否继续？');}
  function installImage(image,src,name,annotations=null){
    state.revision++;state.detectToken++;state.busy=false;
    Object.assign(state,{image,imageData:src,width:image.naturalWidth,height:image.naturalHeight,name:name||'floorplan',walls:[],doors:[],stairs:[],selected:null,draft:[],pointer:null,drag:null,undo:[],redo:[],dirty:false,meta:null});
    if(annotations)Object.assign(state,annotations);
    $('image-info').textContent=`${state.name} · ${state.width} × ${state.height} px`;
    tool('select');refresh();fit();
  }
  let loadToken=0;
  async function loadImageFile(file){
    if(!file)return;
    if(!/^image\/(png|jpeg|webp|bmp|x-ms-bmp)$/i.test(file.type)&&!(/\.(png|jpe?g|webp|bmp)$/i.test(file.name))){status('请选择 PNG、JPG、WebP 或 BMP 图片。',true);return;}
    if(file.size>20*1024*1024){status('图片超过 20 MB，请先压缩或缩小。',true);return;}
    if(!okayToReplace())return;
    const token=++loadToken;
    try{const src=await fileToDataURL(file),image=await decodeImage(src);if(token!==loadToken)return;
      if(image.naturalWidth<16||image.naturalHeight<16||image.naturalWidth*image.naturalHeight>24_000_000)throw new Error('图片每边至少 16 像素，总像素不超过 2400 万，请调整后再导入。');
      installImage(image,src,file.name);status('图片已加载。可以开始自动识别，或使用绘图工具手动标注。');
    }catch(error){status(error.message,true);}
  }
  function validateAnnotations(data,width,height,prefix){
    if(!data||typeof data!=='object')throw new Error('标注数据格式不正确。');
    const result={walls:[],doors:[],stairs:[]};
    const number=(n,max)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=max;
    for(const type of Object.keys(result)){
      if(!Array.isArray(data[type])||data[type].length>20000)throw new Error(`${labels[type]}数组缺失或数量超过限制。`);
      for(const [i,s] of data[type].entries()){
        if(!s||typeof s!=='object')throw new Error(`${labels[type]}第 ${i+1} 项无效。`);
        const shape={id:`${prefix}:${type}:${i}`,source:s.source==='manual'?'manual':'automatic'};
        if(type==='stairs'){
          if(!Array.isArray(s.points)||s.points.length<3||s.points.length>1000||!s.points.every(p=>Array.isArray(p)&&p.length===2&&number(p[0],width)&&number(p[1],height)))throw new Error(`楼梯间第 ${i+1} 项顶点无效或超出原图边界。`);
          shape.points=s.points.map(p=>[p[0],p[1]]);
          if(polygonArea(shape.points)<.01)throw new Error(`楼梯间第 ${i+1} 项没有有效面积。`);
        }else{
          if(!number(s.x1,width)||!number(s.x2,width)||!number(s.y1,height)||!number(s.y2,height))throw new Error(`${labels[type]}第 ${i+1} 项坐标无效或超出原图边界。`);
          Object.assign(shape,{x1:s.x1,y1:s.y1,x2:s.x2,y2:s.y2});
          if(Math.hypot(s.x1-s.x2,s.y1-s.y2)<.01)throw new Error(`${labels[type]}第 ${i+1} 项线段长度为零。`);
        }
        if(typeof s.confidence==='number'&&Number.isFinite(s.confidence))shape.confidence=clamp(s.confidence,0,1);
        result[type].push(shape);
      }
    }
    return result;
  }
  async function importProject(file){
    if(!file)return;if(file.size>80*1024*1024){status('工程文件超过 80 MB。',true);return;}
    if(!okayToReplace())return;const token=++loadToken;
    try{
      const project=JSON.parse(await file.text());
      if(project.schema!=='floorplan-marker-project'||project.version!==1)throw new Error('不是受支持的 Floorplan Marker 工程（需要 schema 和 version 1）。');
      const data=project.image;
      if(!data||typeof data.dataUrl!=='string'||!/^data:image\/(png|jpeg|webp|bmp|x-ms-bmp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(data.dataUrl))throw new Error('工程必须内嵌有效的 PNG、JPG、WebP 或 BMP Base64 图片，不能引用外部 URL。');
      if(data.dataUrl.length>28_000_000)throw new Error('工程中的图片超过 20 MB 限制。');
      if(!Number.isInteger(data.width)||!Number.isInteger(data.height)||data.width<16||data.height<16||data.width*data.height>24_000_000)throw new Error('工程中的图片尺寸无效或超过 2400 万像素。');
      const image=await decodeImage(data.dataUrl);if(token!==loadToken)return;
      if(image.naturalWidth!==data.width||image.naturalHeight!==data.height)throw new Error('工程声明的尺寸与内嵌图片不一致。');
      const annotations=validateAnnotations(project.annotations,data.width,data.height,newId('import'));
      const controls={threshold:'threshold',min_wall_length:'min-wall-length',bridge_gap:'bridge-gap',sensitivity:'sensitivity'};
      const options={};
      if(project.options!==undefined){
        if(!project.options||typeof project.options!=='object'||Array.isArray(project.options))throw new Error('工程中的识别参数格式无效。');
        for(const [key,id] of Object.entries(controls)){
          const value=project.options[key];if(value===undefined)continue;
          if(typeof value!=='number'||!Number.isFinite(value)||value<Number($(id).min)||value>Number($(id).max))throw new Error(`工程中的 ${key} 参数超出支持范围。`);
          options[id]=value;
        }
      }
      installImage(image,data.dataUrl,typeof data.name==='string'?data.name:'imported-plan',annotations);
      for(const [id,value] of Object.entries(options)){$(id).value=String(value);$(id).dispatchEvent(new Event('input'));}
      if(typeof project.meta?.engine==='string')state.meta={engine:project.meta.engine.slice(0,120)};
      status('工程已恢复。坐标使用原图像素，所有标注均可继续编辑。');
    }catch(error){status(`工程导入失败：${error.message}`,true);}
  }
  function getOptions(){return {threshold:Number($('threshold').value),min_wall_length:Number($('min-wall-length').value),bridge_gap:Number($('bridge-gap').value),sensitivity:Number($('sensitivity').value)};}
  async function detect(){
    if(!state.image||state.busy)return;
    const revision=state.revision,token=++state.detectToken;
    state.busy=true;refresh();status('正在本地分析图纸，提取墙线、门洞和楼梯间候选…');
    try{
      const response=await fetch('/api/detect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:state.imageData,options:getOptions()})});
      const result=await response.json().catch(()=>{throw new Error(`服务未返回有效 JSON（HTTP ${response.status}）。`);});
      if(!response.ok)throw new Error(result.error||result.message||`服务错误 ${response.status}`);
      if(token!==state.detectToken||revision!==state.revision)return;
      if(result.width!==state.width||result.height!==state.height)throw new Error('识别结果尺寸与原图不匹配，已停止应用结果。');
      const detected=validateAnnotations(result,state.width,state.height,newId('detect'));
      const before=snapshot();
      for(const type of ['walls','doors','stairs']){
        detected[type].forEach(s=>{s.source='automatic';});
        state[type]=[...state[type].filter(s=>s.source==='manual'),...detected[type]];
      }
      state.selected=null;state.draft=[];state.meta=result.meta||null;record(before);
      const total=Object.values(detected).reduce((sum,a)=>sum+a.length,0);
      const warning=Array.isArray(result.meta?.warnings)?result.meta.warnings.filter(w=>typeof w==='string').join('；'):'';
      status(`已生成 ${total} 个自动候选；请核对并修正。${warning?' '+warning:''}`);
    }catch(error){if(token===state.detectToken&&revision===state.revision)status(`识别失败：${error.message}`,true);}
    finally{if(token===state.detectToken){state.busy=false;refresh();}}
  }

  // Exporters never alter the source image. Hidden layers are excluded from visuals.
  const safeName=()=>state.name.replace(/\.[^.]+$/,'').replace(/[^\p{L}\p{N}_-]+/gu,'_').slice(0,70)||'floorplan';
  function download(blob,name){
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function exportPNG(){
    if(!state.image)return;
    try{
      const out=document.createElement('canvas');out.width=state.width;out.height=state.height;const c=out.getContext('2d');
      c.drawImage(state.image,0,0);for(const type of ['stairs','walls','doors'])if(state.visible[type])state[type].forEach(s=>drawShape(c,s,type));
      out.toBlob(blob=>{if(!blob){status('PNG 导出失败，图片可能过大。',true);return;}download(blob,`${safeName()}_annotated.png`);status('PNG 已导出，尺寸与原图一致。请另外保存 JSON 工程以便继续编辑。');},'image/png');
    }catch(error){status(`PNG 导出失败：${error.message}`,true);}
  }
  function exportSVG(){
    if(!state.image)return;
    const w=state.width,h=state.height,fmt=n=>Number(n.toFixed(3));
    const lines=[`<?xml version="1.0" encoding="UTF-8"?>`,`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,`<title>Floorplan annotations</title>`];
    if($('svg-background').checked){
      const safeData=state.imageData.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      lines.push(`<image width="${w}" height="${h}" href="${safeData}"/>`);
    }
    for(const type of ['stairs','walls','doors']){
      if(!state.visible[type])continue;lines.push(`<g id="${type}" stroke-linecap="round" stroke-linejoin="round">`);
      for(const shape of state[type]){
        if(type==='stairs')lines.push(`<polygon points="${shape.points.map(p=>p.map(fmt).join(',')).join(' ')}" fill="${colors.stairs}" fill-opacity="0.5" stroke="${colors.stairs}" stroke-width="${Math.max(1.5,lineWidth()*.5)}"/>`);
        else lines.push(`<line x1="${fmt(shape.x1)}" y1="${fmt(shape.y1)}" x2="${fmt(shape.x2)}" y2="${fmt(shape.y2)}" stroke="${colors[type]}" stroke-width="${lineWidth()}"/>`);
      }lines.push('</g>');
    }
    lines.push('</svg>');download(new Blob([lines.join('\n')],{type:'image/svg+xml;charset=utf-8'}),`${safeName()}_annotations.svg`);status('SVG 已导出，可在矢量绘图软件中继续编辑。');
  }
  function exportProject(){
    if(!state.image)return;
    const project={schema:'floorplan-marker-project',version:1,createdAt:new Date().toISOString(),image:{name:state.name,width:state.width,height:state.height,dataUrl:state.imageData},annotations:snapshot(),options:getOptions(),meta:{coordinateSystem:'image pixels; origin top-left',stairFillOpacity:0.5,engine:state.meta?.engine||'manual'}};
    download(new Blob([JSON.stringify(project,null,2)],{type:'application/json;charset=utf-8'}),`${safeName()}_project.json`);state.dirty=false;status('JSON 工程已导出，包含原图与全部标注。');
  }
  // Wire controls.
  for(const button of document.querySelectorAll('[data-tool]'))button.addEventListener('click',()=>tool(button.dataset.tool));
  $('upload-button').onclick=$('empty-upload').onclick=()=>$('image-input').click();
  $('image-input').onchange=event=>{loadImageFile(event.target.files[0]);event.target.value='';};
  $('import-button').onclick=()=>$('project-input').click();
  $('project-input').onchange=event=>{importProject(event.target.files[0]);event.target.value='';};
  $('example-button').onclick=async()=>{
    if(!okayToReplace())return;const token=++loadToken;
    try{const response=await fetch('/example.png');if(!response.ok)throw new Error('此安装包未找到示例图，请上传自己的图片。');
      const src=await fileToDataURL(await response.blob()),image=await decodeImage(src);if(token!==loadToken)return;
      installImage(image,src,'example.png');status('示例图已加载。点击“开始自动识别”查看候选标注。');
    }catch(error){status(error.message,true);}
  };
  $('detect-button').onclick=detect;
  $('undo-button').onclick=undo;$('redo-button').onclick=redo;$('delete-button').onclick=deleteSelected;
  $('zoom-in').onclick=()=>zoomAt(1.25);$('zoom-out').onclick=()=>zoomAt(.8);$('fit-button').onclick=fit;
  $('export-png').onclick=exportPNG;$('export-svg').onclick=exportSVG;$('export-project').onclick=exportProject;
  $('help-button').onclick=()=>$('help-dialog').showModal();$('close-help').onclick=()=>$('help-dialog').close();
  for(const id of ['threshold','min-wall-length','bridge-gap','sensitivity'])$(id).addEventListener('input',()=>{$(`${id}-value`).textContent=id==='sensitivity'?Number($(id).value).toFixed(2):$(id).value+(id==='threshold'?'':' px');});
  for(const type of ['walls','doors','stairs'])$(`show-${type}`).onchange=event=>{state.visible[type]=event.target.checked;if(state.selected?.type===type&&!event.target.checked)state.selected=null;refresh();};
  const drop=$('canvas-container');let dragDepth=0;
  drop.addEventListener('dragenter',event=>{event.preventDefault();dragDepth++;$('drop-overlay').hidden=false;});
  drop.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='copy';});
  drop.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-overlay').hidden=true;});
  drop.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;$('drop-overlay').hidden=true;const file=event.dataTransfer.files[0];if(file)file.name.toLowerCase().endsWith('.json')?importProject(file):loadImageFile(file);});
  new ResizeObserver(resize).observe($('canvas-container'));resize();refresh();
  fetch('/api/health').then(response=>{if(!response.ok)throw new Error();return response.json();}).then(result=>{if(!result.ok)throw new Error();$('connection').textContent='本地服务已连接';$('connection').classList.add('ready');}).catch(()=>{$('connection').textContent='本地服务未连接';status('未连接到本地识别服务。请通过启动脚本运行程序；手动标注和导出仍可使用。',true);});
})();
