const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const uri = 'ui://amplitude/charts.html';
const bytes = Number(process.env.FIXTURE_BYTES || 1048577);
const delay = Number(process.env.FIXTURE_DELAY || 0);
const logPath = process.env.FIXTURE_LOG;
const log = (v) => logPath && appendFileSync(logPath, JSON.stringify({time:Date.now(),...v})+'\n');
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
createInterface({input:process.stdin}).on('line', async line => {
 let q; try {q=JSON.parse(line)} catch{return}
 log({method:q.method});
 if (q.method==='initialize') send(q.id,{protocolVersion:'2025-03-26',capabilities:{tools:{},resources:{},extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}},serverInfo:{name:'amplitude-fixture',version:'1.0.0'}});
 else if(q.method==='tools/list') send(q.id,{tools:[{name:'render_amplitude_chart',description:'Render deterministic MCP App chart fixture',inputSchema:{type:'object',properties:{}},_meta:{ui:{resourceUri:uri}}}]});
 else if(q.method==='resources/list') send(q.id,{resources:[{uri,name:'Amplitude chart',mimeType:'text/html;profile=mcp-app'}]});
 else if(q.method==='resources/templates/list') send(q.id,{resourceTemplates:[]});
 else if(q.method==='tools/call') send(q.id,{content:[{type:'text',text:'Local regression fixture: chart tool succeeded; HTML resource is 1,048,577 bytes (synthetic data only).'}],structuredContent:{success:true,shouldRenderUI:true}});
 else if(q.method==='resources/read') {
  await new Promise(r=>setTimeout(r,delay));
  const prefix=`<!doctype html><html><head><style>body{font:14px system-ui;margin:0;padding:20px;color:#16283b;background:#f7faff}h1{font-size:23px;margin:8px 0}p{color:#546575;margin:7px 0}.badge{font-size:11px;font-weight:700;letter-spacing:1px;color:#4262cc}.bars{display:flex;align-items:end;gap:16px;height:85px;margin-top:15px}.bar{width:60px;background:#4262cc;border-radius:5px 5px 0 0;text-align:center;color:white;padding-top:5px}button{float:right;border:0;border-radius:6px;padding:9px 14px;background:#e4ebff;color:#294aaa;cursor:pointer}</style></head><body><div class="badge">LOCAL MCP APP REGRESSION FIXTURE</div><button onclick="this.textContent='Interaction verified'">Test interaction</button><h1>Large chart app loaded</h1><p>HTML resource: 1,048,577 bytes · synthetic data only</p><div class="bars"><div class="bar" style="height:35px">24</div><div class="bar" style="height:50px">38</div><div class="bar" style="height:66px">52</div><div class="bar" style="height:80px">67</div></div><!--`;
  const suffix='--></body></html>';
  const html=prefix+'x'.repeat(Math.max(0,bytes-Buffer.byteLength(prefix+suffix)))+suffix;
  log({resourceBytes:Buffer.byteLength(html),delay});
  send(q.id,{contents:[{uri,mimeType:'text/html;profile=mcp-app',text:html}]});
 } else if(q.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'Method not found'}})+'\n');
});
