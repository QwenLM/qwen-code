import{_ as p,l as C,G,A as B,r as H,X as q,d as U,i as j,c as K}from"./mermaid.core-C0qVpFoT.js";var A="",M="",O="",D=[],b=new Map,v=p(e=>j(e,K()),"sanitizeText"),y=p(e=>{switch(e.type){case"terminal":return{...e,value:v(e.value)};case"nonterminal":return{...e,name:v(e.name)};case"sequence":return{...e,elements:e.elements.map(y)};case"choice":return{...e,alternatives:e.alternatives.map(y)};case"optional":return{...e,element:y(e.element)};case"repetition":return{...e,element:y(e.element),separator:e.separator?y(e.separator):void 0};case"special":return{...e,text:v(e.text)}}},"sanitizeAstNode"),J=p(()=>{A="",M="",O="",D.length=0,b.clear(),H(),C.debug("[Railroad] Database cleared")},"clear"),Y=p(e=>{A=v(e),C.debug("[Railroad] Title set:",e)},"setTitle"),P=p(()=>A,"getTitle"),Q=p(e=>{const i={...e,name:v(e.name),definition:y(e.definition),comment:e.comment?v(e.comment):void 0};C.debug("[Railroad] Adding rule:",i.name),b.has(i.name)&&C.warn(`[Railroad] Rule '${i.name}' is already defined. Overwriting.`),D.push(i),b.set(i.name,i)},"addRule"),Z=p(()=>D,"getRules"),V=p(e=>b.get(e),"getRule"),ee=p(e=>{M=v(e).replace(/^\s+/g,""),C.debug("[Railroad] Accessibility title set:",e)},"setAccTitle"),te=p(()=>M,"getAccTitle"),re=p(e=>{O=v(e).replace(/\n\s+/g,`
`),C.debug("[Railroad] Accessibility description set:",e)},"setAccDescription"),ie=p(()=>O,"getAccDescription"),ne=Y,ae=P,oe={clear:J,setTitle:Y,getTitle:P,addRule:Q,getRules:Z,getRule:V,setAccTitle:ee,getAccTitle:te,setAccDescription:re,getAccDescription:ie,setDiagramTitle:ne,getDiagramTitle:ae},f={compactMode:!1,padding:10,verticalSeparation:8,horizontalSeparation:10,arcRadius:10,fontSize:14,fontFamily:"monospace",terminalFill:"#FFFFC0",terminalStroke:"#000000",terminalTextColor:"#000000",nonTerminalFill:"#FFFFFF",nonTerminalStroke:"#000000",nonTerminalTextColor:"#000000",lineColor:"#000000",strokeWidth:2,markerFill:"#000000",commentFill:"#E8E8E8",commentStroke:"#888888",commentTextColor:"#666666",specialFill:"#F0E0FF",specialStroke:"#8800CC",ruleNameColor:"#000066",showMarkers:!0,markerRadius:5},le=/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$|^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([\d\s%+,./-]+\)$|^[a-z]+$/i,se=/^[\w "',.-]+$/,de=new Set(["compactMode","padding","verticalSeparation","horizontalSeparation","arcRadius","fontSize","fontFamily","terminalFill","terminalStroke","terminalTextColor","nonTerminalFill","nonTerminalStroke","nonTerminalTextColor","lineColor","strokeWidth","markerFill","commentFill","commentStroke","commentTextColor","specialFill","specialStroke","ruleNameColor","showMarkers","markerRadius"]),L=p(e=>e?Object.keys(e).every(i=>i==="railroad"||de.has(i)):!1,"isRailroadStyleOptions"),ce=p(e=>e?"railroad"in e&&e.railroad?e.railroad:L(e)?e:{}:{},"extractRailroadOverrides"),me=p(e=>{if(!e||L(e))return{};const{railroad:i,svgId:a,theme:n,look:t,...r}=e;return r},"extractThemeOverrides"),m=p((e,i)=>{if(typeof e!="string")return i;const a=e.trim();return le.test(a)?a:i},"sanitizeColorValue"),X=p((e,i)=>{if(typeof e!="string")return i;const a=e.trim();return se.test(a)?a:i},"sanitizeFontFamilyValue"),F=p((e,i)=>{const a=typeof e=="number"?e:typeof e=="string"?Number.parseFloat(e):Number.NaN;return Number.isFinite(a)&&a>=0?a:i},"sanitizeNumberValue"),he=p(e=>{const i=typeof e=="number"?e:typeof e=="string"?Number.parseFloat(e):Number.NaN;return Number.isFinite(i)&&i>0?i:void 0},"parseThemeFontSize"),pe=p(e=>{const i=X(e.fontFamily,f.fontFamily),a=he(e.fontSize)??f.fontSize;return{...f,fontFamily:i,fontSize:a,terminalFill:m(e.secondBkg??e.secondaryColor,f.terminalFill),terminalStroke:m(e.secondaryBorderColor??e.lineColor,f.terminalStroke),terminalTextColor:m(e.secondaryTextColor??e.textColor,f.terminalTextColor),nonTerminalFill:m(e.mainBkg??e.background,f.nonTerminalFill),nonTerminalStroke:m(e.primaryBorderColor??e.lineColor,f.nonTerminalStroke),nonTerminalTextColor:m(e.primaryTextColor??e.textColor,f.nonTerminalTextColor),lineColor:m(e.lineColor,f.lineColor),markerFill:m(e.lineColor,f.markerFill),commentFill:m(e.labelBackground??e.tertiaryColor,f.commentFill),commentStroke:m(e.tertiaryBorderColor??e.lineColor,f.commentStroke),commentTextColor:m(e.tertiaryTextColor??e.textColor,f.commentTextColor),specialFill:m(e.tertiaryColor??e.secondaryColor,f.specialFill),specialStroke:m(e.tertiaryBorderColor??e.secondaryBorderColor,f.specialStroke),ruleNameColor:m(e.titleColor??e.textColor,f.ruleNameColor)}},"buildThemeDefaults"),E=p(e=>{const i=B(),a={...q(),...i.themeVariables??{},...me(e)},n=pe(a),t={...i.railroad??{},...ce(e)};return{compactMode:t.compactMode??n.compactMode,padding:F(t.padding,n.padding),verticalSeparation:F(t.verticalSeparation,n.verticalSeparation),horizontalSeparation:F(t.horizontalSeparation,n.horizontalSeparation),arcRadius:F(t.arcRadius,n.arcRadius),fontSize:F(t.fontSize,n.fontSize),fontFamily:X(t.fontFamily,n.fontFamily),terminalFill:m(t.terminalFill,n.terminalFill),terminalStroke:m(t.terminalStroke,n.terminalStroke),terminalTextColor:m(t.terminalTextColor,n.terminalTextColor),nonTerminalFill:m(t.nonTerminalFill,n.nonTerminalFill),nonTerminalStroke:m(t.nonTerminalStroke,n.nonTerminalStroke),nonTerminalTextColor:m(t.nonTerminalTextColor,n.nonTerminalTextColor),lineColor:m(t.lineColor,n.lineColor),strokeWidth:F(t.strokeWidth,n.strokeWidth),markerFill:m(t.markerFill,n.markerFill),commentFill:m(t.commentFill,n.commentFill),commentStroke:m(t.commentStroke,n.commentStroke),commentTextColor:m(t.commentTextColor,n.commentTextColor),specialFill:m(t.specialFill,n.specialFill),specialStroke:m(t.specialStroke,n.specialStroke),ruleNameColor:m(t.ruleNameColor,n.ruleNameColor),showMarkers:t.showMarkers??n.showMarkers,markerRadius:F(t.markerRadius,n.markerRadius)}},"buildRailroadStyleOptions"),Te=p(e=>{const{fontFamily:i,fontSize:a,terminalFill:n,terminalStroke:t,terminalTextColor:r,nonTerminalFill:o,nonTerminalStroke:g,nonTerminalTextColor:l,lineColor:s,strokeWidth:h,markerFill:u,commentFill:c,commentStroke:w,commentTextColor:d,specialFill:T,specialStroke:z,ruleNameColor:S}=E(e);return`
  .railroad-diagram {
    font-family: ${i};
    font-size: ${a}px;
  }

  .railroad-terminal rect {
    fill: ${n};
    stroke: ${t};
    stroke-width: ${h}px;
  }

  .railroad-terminal text {
    fill: ${r};
    font-family: ${i};
    font-size: ${a}px;
    text-anchor: middle;
    dominant-baseline: middle;
  }

  .railroad-nonterminal rect {
    fill: ${o};
    stroke: ${g};
    stroke-width: ${h}px;
  }

  .railroad-nonterminal text {
    fill: ${l};
    font-family: ${i};
    font-size: ${a}px;
    text-anchor: middle;
    dominant-baseline: middle;
  }

  .railroad-line {
    stroke: ${s};
    stroke-width: ${h}px;
    fill: none;
  }

  .railroad-start circle,
  .railroad-end circle {
    fill: ${u};
  }

  .railroad-comment ellipse {
    fill: ${c};
    stroke: ${w};
    stroke-width: ${h}px;
  }

  .railroad-comment text {
    fill: ${d};
    font-style: italic;
    font-family: ${i};
    font-size: ${a}px;
    text-anchor: middle;
    dominant-baseline: middle;
  }

  .railroad-special rect {
    fill: ${T};
    stroke: ${z};
    stroke-width: ${h}px;
    stroke-dasharray: 5,3;
  }

  .railroad-special text {
    fill: ${l};
    font-family: ${i};
    font-size: ${a}px;
    text-anchor: middle;
    dominant-baseline: middle;
  }

  .railroad-rule-name {
    font-weight: bold;
    fill: ${S};
    font-family: ${i};
    font-size: ${a}px;
  }

  .railroad-group {
    /* Grouping container, no specific styles */
  }
`},"getStyles"),R,x=(R=class{constructor(){this.d=""}moveTo(i,a){return this.d+=`M ${i} ${a} `,this}lineTo(i,a){return this.d+=`L ${i} ${a} `,this}horizontalTo(i){return this.d+=`H ${i} `,this}verticalTo(i){return this.d+=`V ${i} `,this}arcTo(i,a,n,t,r,o,g){return this.d+=`A ${i} ${a} ${n} ${t?1:0} ${r?1:0} ${o} ${g} `,this}build(){return this.d.trim()}},p(R,"PathBuilder"),R),$,ue=($=class{constructor(i,a=E()){this.textCache=new Map,this.svg=i,this.config=a}measureText(i){if(this.textCache.has(i))return this.textCache.get(i);const a=this.svg.append("text").attr("font-family",this.config.fontFamily).attr("font-size",this.config.fontSize).text(i),n=a.node().getBBox(),t={width:n.width,height:n.height};return a.remove(),this.textCache.set(i,t),t}renderTerminal(i,a){const n=this.measureText(a),t=n.width+this.config.padding*2,r=n.height+this.config.padding*2,o=i.append("g").attr("class","railroad-terminal");return o.append("rect").attr("x",0).attr("y",0).attr("width",t).attr("height",r).attr("rx",10).attr("ry",10),o.append("text").attr("x",t/2).attr("y",r/2).text(a),{element:o.node(),dimensions:{width:t,height:r,up:r/2,down:r/2}}}renderNonTerminal(i,a){const n=this.measureText(a),t=n.width+this.config.padding*2,r=n.height+this.config.padding*2,o=i.append("g").attr("class","railroad-nonterminal");return o.append("rect").attr("x",0).attr("y",0).attr("width",t).attr("height",r),o.append("text").attr("x",t/2).attr("y",r/2).text(a),{element:o.node(),dimensions:{width:t,height:r,up:r/2,down:r/2}}}renderSequence(i,a){const n=a.map(s=>this.renderExpression(i,s));let t=0,r=0,o=0;for(const s of n)t+=s.dimensions.width,r=Math.max(r,s.dimensions.up),o=Math.max(o,s.dimensions.down);t+=(n.length-1)*this.config.horizontalSeparation;const g=i.append("g").attr("class","railroad-sequence");let l=0;for(let s=0;s<n.length;s++){const h=n[s],u=r-h.dimensions.up;if(g.node().appendChild(h.element).setAttribute("transform",`translate(${l}, ${u})`),s<n.length-1){const w=l+h.dimensions.width,d=w+this.config.horizontalSeparation,T=r;g.append("path").attr("class","railroad-line").attr("d",new x().moveTo(w,T).lineTo(d,T).build())}l+=h.dimensions.width+this.config.horizontalSeparation}return{element:g.node(),dimensions:{width:t,height:r+o,up:r,down:o}}}renderChoice(i,a){const n=a.map(c=>this.renderExpression(i,c));let t=0,r=0;for(const c of n)t=Math.max(t,c.dimensions.width),r+=c.dimensions.height;r+=(n.length-1)*this.config.verticalSeparation;const o=this.config.arcRadius,g=o*4,l=t+g,s=i.append("g").attr("class","railroad-choice");let h=0;const u=r/2;for(const c of n){const w=h,d=w+c.dimensions.up,T=o*2+(t-c.dimensions.width)/2;s.node().appendChild(c.element).setAttribute("transform",`translate(${T}, ${w})`);const S=new x,k=d>u;d===u?S.moveTo(0,u).lineTo(T,d):S.moveTo(0,u).arcTo(o,o,0,!1,k,o,u+(k?o:-o)).lineTo(o,d-(k?o:-o)).arcTo(o,o,0,!1,!k,o*2,d).lineTo(T,d),s.append("path").attr("class","railroad-line").attr("d",S.build());const N=new x,_=T+c.dimensions.width,I=l-o*2;d===u?N.moveTo(_,d).lineTo(l,u):N.moveTo(_,d).lineTo(I,d).arcTo(o,o,0,!1,!k,l-o,d+(k?-o:o)).lineTo(l-o,u+(k?o:-o)).arcTo(o,o,0,!1,k,l,u),s.append("path").attr("class","railroad-line").attr("d",N.build()),h+=c.dimensions.height+this.config.verticalSeparation}return{element:s.node(),dimensions:{width:l,height:r,up:u,down:r-u}}}renderOptional(i,a){const n=this.renderExpression(i,a),t=this.config.arcRadius,r=t*2,o=n.dimensions.width+t*4,g=n.dimensions.height+r,l=i.append("g").attr("class","railroad-optional"),s=t*2,h=r;l.node().appendChild(n.element).setAttribute("transform",`translate(${s}, ${h})`);const c=h+n.dimensions.up,w=new x().moveTo(0,c).lineTo(t*2,c);l.append("path").attr("class","railroad-line").attr("d",w.build());const d=new x().moveTo(s+n.dimensions.width,c).lineTo(o,c);l.append("path").attr("class","railroad-line").attr("d",d.build());const T=new x().moveTo(0,c).arcTo(t,t,0,!1,!1,t,c-t).lineTo(t,t).arcTo(t,t,0,!1,!0,t*2,0).lineTo(o-t*2,0).arcTo(t,t,0,!1,!0,o-t,t).lineTo(o-t,c-t).arcTo(t,t,0,!1,!1,o,c);return l.append("path").attr("class","railroad-line").attr("d",T.build()),{element:l.node(),dimensions:{width:o,height:g,up:c,down:g-c}}}renderRepetition(i,a,n){const t=this.renderExpression(i,a),r=this.config.arcRadius,o=r*2,g=t.dimensions.width+r*4,l=n===0,s=t.dimensions.height+o+(l?o:0),h=i.append("g").attr("class","railroad-repetition"),u=r*2,c=l?o:0;h.node().appendChild(t.element).setAttribute("transform",`translate(${u}, ${c})`);const d=c+t.dimensions.up;h.append("path").attr("class","railroad-line").attr("d",new x().moveTo(0,d).lineTo(r*2,d).build()),h.append("path").attr("class","railroad-line").attr("d",new x().moveTo(u+t.dimensions.width,d).lineTo(g,d).build());const T=c+t.dimensions.height+r,z=new x().moveTo(u+t.dimensions.width,d).arcTo(r,r,0,!1,!0,u+t.dimensions.width+r,d+r).lineTo(u+t.dimensions.width+r,T).arcTo(r,r,0,!1,!0,u+t.dimensions.width,T+r).lineTo(r*2,T+r).arcTo(r,r,0,!1,!0,r,T).lineTo(r,d+r).arcTo(r,r,0,!1,!0,r*2,d);if(h.append("path").attr("class","railroad-line").attr("d",z.build()),l){const S=new x().moveTo(0,d).arcTo(r,r,0,!1,!1,r,d-r).lineTo(r,r).arcTo(r,r,0,!1,!0,r*2,0).lineTo(g-r*2,0).arcTo(r,r,0,!1,!0,g-r,r).lineTo(g-r,d-r).arcTo(r,r,0,!1,!1,g,d);h.append("path").attr("class","railroad-line").attr("d",S.build())}return{element:h.node(),dimensions:{width:g,height:s,up:d,down:s-d}}}renderSpecial(i,a){const n=this.measureText("? "+a+" ?"),t=n.width+this.config.padding*2,r=n.height+this.config.padding*2,o=i.append("g").attr("class","railroad-special");return o.append("rect").attr("x",0).attr("y",0).attr("width",t).attr("height",r),o.append("text").attr("x",t/2).attr("y",r/2).text("? "+a+" ?"),{element:o.node(),dimensions:{width:t,height:r,up:r/2,down:r/2}}}renderExpression(i,a){switch(a.type){case"terminal":return this.renderTerminal(i,a.value);case"nonterminal":return this.renderNonTerminal(i,a.name);case"sequence":return this.renderSequence(i,a.elements);case"choice":return this.renderChoice(i,a.alternatives);case"optional":return this.renderOptional(i,a.element);case"repetition":return this.renderRepetition(i,a.element,a.min);case"special":return this.renderSpecial(i,a.text);default:throw new Error(`Unknown node type: ${a.type}`)}}renderRule(i,a){const n=this.svg.append("g").attr("class","railroad-rule").attr("transform",`translate(0, ${a})`),t=i.name+" =",r=this.measureText(t).width+20,o=r+20,g=n.append("g"),l=this.renderExpression(g,i.definition),s=Math.max(20,l.dimensions.up),h=s-l.dimensions.up;return g.attr("transform",`translate(${o}, ${h})`),n.append("g").attr("class","railroad-rule-name-group").append("text").attr("class","railroad-rule-name").attr("x",0).attr("y",s).text(t),n.append("g").attr("class","railroad-start").append("circle").attr("cx",r).attr("cy",s).attr("r",this.config.markerRadius),n.append("g").attr("class","railroad-end").append("circle").attr("cx",o+l.dimensions.width+10).attr("cy",s).attr("r",this.config.markerRadius),n.append("path").attr("class","railroad-line").attr("d",new x().moveTo(r+this.config.markerRadius,s).lineTo(o,s).build()),n.append("path").attr("class","railroad-line").attr("d",new x().moveTo(o+l.dimensions.width,s).lineTo(o+l.dimensions.width+10-this.config.markerRadius,s).build()),{height:Math.max(40,h+l.dimensions.height+this.config.padding*2),width:o+l.dimensions.width+10+this.config.markerRadius}}renderDiagram(i){let a=this.config.padding,n=0;for(const t of i){const r=this.renderRule(t,a);a+=r.height+this.config.verticalSeparation,n=Math.max(n,r.width)}return{width:n+this.config.padding*2,height:a+this.config.padding}}},p($,"RailroadRenderer"),$),W=p((e,i,a)=>{U(e,i.height,i.width,a),e.attr("viewBox",`0 0 ${i.width} ${i.height}`)},"configureRailroadSvgSize"),ge=p((e,i,a)=>{C.debug(`[Railroad] Rendering diagram
`+e);try{const n=G(i);n.attr("class","railroad-diagram");const r=B().railroad?.useMaxWidth??!0,o=oe.getRules();if(C.debug(`[Railroad] Rendering ${o.length} rules`),o.length===0){C.warn("[Railroad] No rules to render"),W(n,{height:100,width:200},r);return}const l=new ue(n,E()).renderDiagram(o);W(n,l,r),C.debug("[Railroad] Render complete")}catch(n){throw C.error("[Railroad] Render error:",n),n}},"draw"),xe={draw:ge};export{oe as d,Te as g,xe as r};
