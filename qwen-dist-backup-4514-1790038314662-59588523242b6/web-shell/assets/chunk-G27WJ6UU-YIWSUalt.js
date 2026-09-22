import{g as ee}from"./chunk-XXDRQBXY-DpL325Hu.js";import{s as se}from"./chunk-POPQ4Y6H-_UIsVriH.js";import{_ as p,l as b,c as $,y as ie,z as re,a as ae,b as ne,g as oe,s as le,p as ce,q as he,ab as ue,k as j,r as de,j as kt,a6 as fe}from"./mermaid.core-C0qVpFoT.js";import{f as pe}from"./chunk-F27PBJKO-CMQviybe.js";var Ct=function(){var t=p(function(V,o,h,a){for(h=h||{},a=V.length;a--;h[V[a]]=o);return h},"o"),e=[1,2],s=[1,3],n=[1,4],r=[2,4],c=[1,9],u=[1,11],S=[1,16],d=[1,17],T=[1,18],E=[1,19],m=[1,33],L=[1,20],D=[1,21],f=[1,22],I=[1,23],R=[1,24],C=[1,26],F=[1,27],A=[1,28],P=[1,29],w=[1,30],z=[1,31],rt=[1,32],at=[1,35],nt=[1,36],ot=[1,37],lt=[1,38],K=[1,34],y=[1,4,5,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,41,45,48,51,52,53,54,57],ct=[1,4,5,14,15,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,39,40,41,45,48,51,52,53,54,57],Lt=[4,5,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,41,45,48,51,52,53,54,57],gt={trace:p(function(){},"trace"),yy:{},symbols_:{error:2,start:3,SPACE:4,NL:5,SD:6,document:7,line:8,statement:9,classDefStatement:10,styleStatement:11,cssClassStatement:12,idStatement:13,DESCR:14,"-->":15,HIDE_EMPTY:16,scale:17,WIDTH:18,COMPOSIT_STATE:19,STRUCT_START:20,STRUCT_STOP:21,STATE_DESCR:22,AS:23,ID:24,FORK:25,JOIN:26,CHOICE:27,CONCURRENT:28,note:29,notePosition:30,NOTE_TEXT:31,direction:32,acc_title:33,acc_title_value:34,acc_descr:35,acc_descr_value:36,acc_descr_multiline_value:37,CLICK:38,STRING:39,HREF:40,classDef:41,CLASSDEF_ID:42,CLASSDEF_STYLEOPTS:43,DEFAULT:44,style:45,STYLE_IDS:46,STYLEDEF_STYLEOPTS:47,class:48,CLASSENTITY_IDS:49,STYLECLASS:50,direction_tb:51,direction_bt:52,direction_rl:53,direction_lr:54,eol:55,";":56,EDGE_STATE:57,STYLE_SEPARATOR:58,left_of:59,right_of:60,$accept:0,$end:1},terminals_:{2:"error",4:"SPACE",5:"NL",6:"SD",14:"DESCR",15:"-->",16:"HIDE_EMPTY",17:"scale",18:"WIDTH",19:"COMPOSIT_STATE",20:"STRUCT_START",21:"STRUCT_STOP",22:"STATE_DESCR",23:"AS",24:"ID",25:"FORK",26:"JOIN",27:"CHOICE",28:"CONCURRENT",29:"note",31:"NOTE_TEXT",33:"acc_title",34:"acc_title_value",35:"acc_descr",36:"acc_descr_value",37:"acc_descr_multiline_value",38:"CLICK",39:"STRING",40:"HREF",41:"classDef",42:"CLASSDEF_ID",43:"CLASSDEF_STYLEOPTS",44:"DEFAULT",45:"style",46:"STYLE_IDS",47:"STYLEDEF_STYLEOPTS",48:"class",49:"CLASSENTITY_IDS",50:"STYLECLASS",51:"direction_tb",52:"direction_bt",53:"direction_rl",54:"direction_lr",56:";",57:"EDGE_STATE",58:"STYLE_SEPARATOR",59:"left_of",60:"right_of"},productions_:[0,[3,2],[3,2],[3,2],[7,0],[7,2],[8,2],[8,1],[8,1],[9,1],[9,1],[9,1],[9,1],[9,2],[9,3],[9,4],[9,1],[9,2],[9,1],[9,4],[9,3],[9,6],[9,1],[9,1],[9,1],[9,1],[9,4],[9,4],[9,1],[9,2],[9,2],[9,1],[9,5],[9,5],[10,3],[10,3],[11,3],[12,3],[32,1],[32,1],[32,1],[32,1],[55,1],[55,1],[13,1],[13,1],[13,3],[13,3],[30,1],[30,1]],performAction:p(function(o,h,a,g,_,i,B){var l=i.length-1;switch(_){case 3:return g.setRootDoc(i[l]),i[l];case 4:this.$=[];break;case 5:i[l]!="nl"&&(i[l-1].push(i[l]),this.$=i[l-1]);break;case 6:case 7:this.$=i[l];break;case 8:this.$="nl";break;case 12:this.$=i[l];break;case 13:const Z=i[l-1];Z.description=g.trimColon(i[l]),this.$=Z;break;case 14:this.$={stmt:"relation",state1:i[l-2],state2:i[l]};break;case 15:const Tt=g.trimColon(i[l]);this.$={stmt:"relation",state1:i[l-3],state2:i[l-1],description:Tt};break;case 19:this.$={stmt:"state",id:i[l-3],type:"default",description:"",doc:i[l-1]};break;case 20:var Y=i[l],X=i[l-2].trim();if(i[l].match(":")){var ut=i[l].split(":");Y=ut[0],X=[X,ut[1]]}this.$={stmt:"state",id:Y,type:"default",description:X};break;case 21:this.$={stmt:"state",id:i[l-3],type:"default",description:i[l-5],doc:i[l-1]};break;case 22:this.$={stmt:"state",id:i[l],type:"fork"};break;case 23:this.$={stmt:"state",id:i[l],type:"join"};break;case 24:this.$={stmt:"state",id:i[l],type:"choice"};break;case 25:this.$={stmt:"state",id:g.getDividerId(),type:"divider"};break;case 26:this.$={stmt:"state",id:i[l-1].trim(),note:{position:i[l-2].trim(),text:i[l].trim()}};break;case 29:this.$=i[l].trim(),g.setAccTitle(this.$);break;case 30:case 31:this.$=i[l].trim(),g.setAccDescription(this.$);break;case 32:this.$={stmt:"click",id:i[l-3],url:i[l-2],tooltip:i[l-1]};break;case 33:this.$={stmt:"click",id:i[l-3],url:i[l-1],tooltip:""};break;case 34:case 35:this.$={stmt:"classDef",id:i[l-1].trim(),classes:i[l].trim()};break;case 36:this.$={stmt:"style",id:i[l-1].trim(),styleClass:i[l].trim()};break;case 37:this.$={stmt:"applyClass",id:i[l-1].trim(),styleClass:i[l].trim()};break;case 38:g.setDirection("TB"),this.$={stmt:"dir",value:"TB"};break;case 39:g.setDirection("BT"),this.$={stmt:"dir",value:"BT"};break;case 40:g.setDirection("RL"),this.$={stmt:"dir",value:"RL"};break;case 41:g.setDirection("LR"),this.$={stmt:"dir",value:"LR"};break;case 44:case 45:this.$={stmt:"state",id:i[l].trim(),type:"default",description:""};break;case 46:this.$={stmt:"state",id:i[l-2].trim(),classes:[i[l].trim()],type:"default",description:""};break;case 47:this.$={stmt:"state",id:i[l-2].trim(),classes:[i[l].trim()],type:"default",description:""};break}},"anonymous"),table:[{3:1,4:e,5:s,6:n},{1:[3]},{3:5,4:e,5:s,6:n},{3:6,4:e,5:s,6:n},t([1,4,5,16,17,19,22,24,25,26,27,28,29,33,35,37,38,41,45,48,51,52,53,54,57],r,{7:7}),{1:[2,1]},{1:[2,2]},{1:[2,3],4:c,5:u,8:8,9:10,10:12,11:13,12:14,13:15,16:S,17:d,19:T,22:E,24:m,25:L,26:D,27:f,28:I,29:R,32:25,33:C,35:F,37:A,38:P,41:w,45:z,48:rt,51:at,52:nt,53:ot,54:lt,57:K},t(y,[2,5]),{9:39,10:12,11:13,12:14,13:15,16:S,17:d,19:T,22:E,24:m,25:L,26:D,27:f,28:I,29:R,32:25,33:C,35:F,37:A,38:P,41:w,45:z,48:rt,51:at,52:nt,53:ot,54:lt,57:K},t(y,[2,7]),t(y,[2,8]),t(y,[2,9]),t(y,[2,10]),t(y,[2,11]),t(y,[2,12],{14:[1,40],15:[1,41]}),t(y,[2,16]),{18:[1,42]},t(y,[2,18],{20:[1,43]}),{23:[1,44]},t(y,[2,22]),t(y,[2,23]),t(y,[2,24]),t(y,[2,25]),{30:45,31:[1,46],59:[1,47],60:[1,48]},t(y,[2,28]),{34:[1,49]},{36:[1,50]},t(y,[2,31]),{13:51,24:m,57:K},{42:[1,52],44:[1,53]},{46:[1,54]},{49:[1,55]},t(ct,[2,44],{58:[1,56]}),t(ct,[2,45],{58:[1,57]}),t(y,[2,38]),t(y,[2,39]),t(y,[2,40]),t(y,[2,41]),t(y,[2,6]),t(y,[2,13]),{13:58,24:m,57:K},t(y,[2,17]),t(Lt,r,{7:59}),{24:[1,60]},{24:[1,61]},{23:[1,62]},{24:[2,48]},{24:[2,49]},t(y,[2,29]),t(y,[2,30]),{39:[1,63],40:[1,64]},{43:[1,65]},{43:[1,66]},{47:[1,67]},{50:[1,68]},{24:[1,69]},{24:[1,70]},t(y,[2,14],{14:[1,71]}),{4:c,5:u,8:8,9:10,10:12,11:13,12:14,13:15,16:S,17:d,19:T,21:[1,72],22:E,24:m,25:L,26:D,27:f,28:I,29:R,32:25,33:C,35:F,37:A,38:P,41:w,45:z,48:rt,51:at,52:nt,53:ot,54:lt,57:K},t(y,[2,20],{20:[1,73]}),{31:[1,74]},{24:[1,75]},{39:[1,76]},{39:[1,77]},t(y,[2,34]),t(y,[2,35]),t(y,[2,36]),t(y,[2,37]),t(ct,[2,46]),t(ct,[2,47]),t(y,[2,15]),t(y,[2,19]),t(Lt,r,{7:78}),t(y,[2,26]),t(y,[2,27]),{5:[1,79]},{5:[1,80]},{4:c,5:u,8:8,9:10,10:12,11:13,12:14,13:15,16:S,17:d,19:T,21:[1,81],22:E,24:m,25:L,26:D,27:f,28:I,29:R,32:25,33:C,35:F,37:A,38:P,41:w,45:z,48:rt,51:at,52:nt,53:ot,54:lt,57:K},t(y,[2,32]),t(y,[2,33]),t(y,[2,21])],defaultActions:{5:[2,1],6:[2,2],47:[2,48],48:[2,49]},parseError:p(function(o,h){if(h.recoverable)this.trace(o);else{var a=new Error(o);throw a.hash=h,a}},"parseError"),parse:p(function(o){var h=this,a=[0],g=[],_=[null],i=[],B=this.table,l="",Y=0,X=0,ut=2,Z=1,Tt=i.slice.call(arguments,1),k=Object.create(this.lexer),U={yy:{}};for(var Et in this.yy)Object.prototype.hasOwnProperty.call(this.yy,Et)&&(U.yy[Et]=this.yy[Et]);k.setInput(o,U.yy),U.yy.lexer=k,U.yy.parser=this,typeof k.yylloc>"u"&&(k.yylloc={});var _t=k.yylloc;i.push(_t);var Zt=k.options&&k.options.ranges;typeof U.yy.parseError=="function"?this.parseError=U.yy.parseError:this.parseError=Object.getPrototypeOf(this).parseError;function te(N){a.length=a.length-2*N,_.length=_.length-N,i.length=i.length-N}p(te,"popStack");function It(){var N;return N=g.pop()||k.lex()||Z,typeof N!="number"&&(N instanceof Array&&(g=N,N=g.pop()),N=h.symbols_[N]||N),N}p(It,"lex");for(var x,W,O,mt,J={},dt,G,wt,ft;;){if(W=a[a.length-1],this.defaultActions[W]?O=this.defaultActions[W]:((x===null||typeof x>"u")&&(x=It()),O=B[W]&&B[W][x]),typeof O>"u"||!O.length||!O[0]){var bt="";ft=[];for(dt in B[W])this.terminals_[dt]&&dt>ut&&ft.push("'"+this.terminals_[dt]+"'");k.showPosition?bt="Parse error on line "+(Y+1)+`:
`+k.showPosition()+`
Expecting `+ft.join(", ")+", got '"+(this.terminals_[x]||x)+"'":bt="Parse error on line "+(Y+1)+": Unexpected "+(x==Z?"end of input":"'"+(this.terminals_[x]||x)+"'"),this.parseError(bt,{text:k.match,token:this.terminals_[x]||x,line:k.yylineno,loc:_t,expected:ft})}if(O[0]instanceof Array&&O.length>1)throw new Error("Parse Error: multiple actions possible at state: "+W+", token: "+x);switch(O[0]){case 1:a.push(x),_.push(k.yytext),i.push(k.yylloc),a.push(O[1]),x=null,X=k.yyleng,l=k.yytext,Y=k.yylineno,_t=k.yylloc;break;case 2:if(G=this.productions_[O[1]][1],J.$=_[_.length-G],J._$={first_line:i[i.length-(G||1)].first_line,last_line:i[i.length-1].last_line,first_column:i[i.length-(G||1)].first_column,last_column:i[i.length-1].last_column},Zt&&(J._$.range=[i[i.length-(G||1)].range[0],i[i.length-1].range[1]]),mt=this.performAction.apply(J,[l,X,Y,U.yy,O[1],_,i].concat(Tt)),typeof mt<"u")return mt;G&&(a=a.slice(0,-1*G*2),_=_.slice(0,-1*G),i=i.slice(0,-1*G)),a.push(this.productions_[O[1]][0]),_.push(J.$),i.push(J._$),wt=B[a[a.length-2]][a[a.length-1]],a.push(wt);break;case 3:return!0}}return!0},"parse")},Qt=function(){var V={EOF:1,parseError:p(function(h,a){if(this.yy.parser)this.yy.parser.parseError(h,a);else throw new Error(h)},"parseError"),setInput:p(function(o,h){return this.yy=h||this.yy||{},this._input=o,this._more=this._backtrack=this.done=!1,this.yylineno=this.yyleng=0,this.yytext=this.matched=this.match="",this.conditionStack=["INITIAL"],this.yylloc={first_line:1,first_column:0,last_line:1,last_column:0},this.options.ranges&&(this.yylloc.range=[0,0]),this.offset=0,this},"setInput"),input:p(function(){var o=this._input[0];this.yytext+=o,this.yyleng++,this.offset++,this.match+=o,this.matched+=o;var h=o.match(/(?:\r\n?|\n).*/g);return h?(this.yylineno++,this.yylloc.last_line++):this.yylloc.last_column++,this.options.ranges&&this.yylloc.range[1]++,this._input=this._input.slice(1),o},"input"),unput:p(function(o){var h=o.length,a=o.split(/(?:\r\n?|\n)/g);this._input=o+this._input,this.yytext=this.yytext.substr(0,this.yytext.length-h),this.offset-=h;var g=this.match.split(/(?:\r\n?|\n)/g);this.match=this.match.substr(0,this.match.length-1),this.matched=this.matched.substr(0,this.matched.length-1),a.length-1&&(this.yylineno-=a.length-1);var _=this.yylloc.range;return this.yylloc={first_line:this.yylloc.first_line,last_line:this.yylineno+1,first_column:this.yylloc.first_column,last_column:a?(a.length===g.length?this.yylloc.first_column:0)+g[g.length-a.length].length-a[0].length:this.yylloc.first_column-h},this.options.ranges&&(this.yylloc.range=[_[0],_[0]+this.yyleng-h]),this.yyleng=this.yytext.length,this},"unput"),more:p(function(){return this._more=!0,this},"more"),reject:p(function(){if(this.options.backtrack_lexer)this._backtrack=!0;else return this.parseError("Lexical error on line "+(this.yylineno+1)+`. You can only invoke reject() in the lexer when the lexer is of the backtracking persuasion (options.backtrack_lexer = true).
`+this.showPosition(),{text:"",token:null,line:this.yylineno});return this},"reject"),less:p(function(o){this.unput(this.match.slice(o))},"less"),pastInput:p(function(){var o=this.matched.substr(0,this.matched.length-this.match.length);return(o.length>20?"...":"")+o.substr(-20).replace(/\n/g,"")},"pastInput"),upcomingInput:p(function(){var o=this.match;return o.length<20&&(o+=this._input.substr(0,20-o.length)),(o.substr(0,20)+(o.length>20?"...":"")).replace(/\n/g,"")},"upcomingInput"),showPosition:p(function(){var o=this.pastInput(),h=new Array(o.length+1).join("-");return o+this.upcomingInput()+`
`+h+"^"},"showPosition"),test_match:p(function(o,h){var a,g,_;if(this.options.backtrack_lexer&&(_={yylineno:this.yylineno,yylloc:{first_line:this.yylloc.first_line,last_line:this.last_line,first_column:this.yylloc.first_column,last_column:this.yylloc.last_column},yytext:this.yytext,match:this.match,matches:this.matches,matched:this.matched,yyleng:this.yyleng,offset:this.offset,_more:this._more,_input:this._input,yy:this.yy,conditionStack:this.conditionStack.slice(0),done:this.done},this.options.ranges&&(_.yylloc.range=this.yylloc.range.slice(0))),g=o[0].match(/(?:\r\n?|\n).*/g),g&&(this.yylineno+=g.length),this.yylloc={first_line:this.yylloc.last_line,last_line:this.yylineno+1,first_column:this.yylloc.last_column,last_column:g?g[g.length-1].length-g[g.length-1].match(/\r?\n?/)[0].length:this.yylloc.last_column+o[0].length},this.yytext+=o[0],this.match+=o[0],this.matches=o,this.yyleng=this.yytext.length,this.options.ranges&&(this.yylloc.range=[this.offset,this.offset+=this.yyleng]),this._more=!1,this._backtrack=!1,this._input=this._input.slice(o[0].length),this.matched+=o[0],a=this.performAction.call(this,this.yy,this,h,this.conditionStack[this.conditionStack.length-1]),this.done&&this._input&&(this.done=!1),a)return a;if(this._backtrack){for(var i in _)this[i]=_[i];return!1}return!1},"test_match"),next:p(function(){if(this.done)return this.EOF;this._input||(this.done=!0);var o,h,a,g;this._more||(this.yytext="",this.match="");for(var _=this._currentRules(),i=0;i<_.length;i++)if(a=this._input.match(this.rules[_[i]]),a&&(!h||a[0].length>h[0].length)){if(h=a,g=i,this.options.backtrack_lexer){if(o=this.test_match(a,_[i]),o!==!1)return o;if(this._backtrack){h=!1;continue}else return!1}else if(!this.options.flex)break}return h?(o=this.test_match(h,_[g]),o!==!1?o:!1):this._input===""?this.EOF:this.parseError("Lexical error on line "+(this.yylineno+1)+`. Unrecognized text.
`+this.showPosition(),{text:"",token:null,line:this.yylineno})},"next"),lex:p(function(){var h=this.next();return h||this.lex()},"lex"),begin:p(function(h){this.conditionStack.push(h)},"begin"),popState:p(function(){var h=this.conditionStack.length-1;return h>0?this.conditionStack.pop():this.conditionStack[0]},"popState"),_currentRules:p(function(){return this.conditionStack.length&&this.conditionStack[this.conditionStack.length-1]?this.conditions[this.conditionStack[this.conditionStack.length-1]].rules:this.conditions.INITIAL.rules},"_currentRules"),topState:p(function(h){return h=this.conditionStack.length-1-Math.abs(h||0),h>=0?this.conditionStack[h]:"INITIAL"},"topState"),pushState:p(function(h){this.begin(h)},"pushState"),stateStackSize:p(function(){return this.conditionStack.length},"stateStackSize"),options:{"case-insensitive":!0},performAction:p(function(h,a,g,_){function i(){const B=a.yytext.indexOf("%%");if(B===0)return!1;if(B>0){const l=a.yytext.slice(0,B),Y=a.yytext.slice(B);Y&&h.lexer.unput(Y),a.yytext=l}return!0}switch(p(i,"processId"),g){case 0:return 38;case 1:return 40;case 2:return 39;case 3:return 44;case 4:return 51;case 5:return 52;case 6:return 53;case 7:return 54;case 8:return 5;case 9:break;case 10:break;case 11:break;case 12:break;case 13:return this.pushState("SCALE"),17;case 14:return 18;case 15:this.popState();break;case 16:return this.begin("acc_title"),33;case 17:return this.popState(),"acc_title_value";case 18:return this.begin("acc_descr"),35;case 19:return this.popState(),"acc_descr_value";case 20:this.begin("acc_descr_multiline");break;case 21:this.popState();break;case 22:return"acc_descr_multiline_value";case 23:return this.pushState("CLASSDEF"),41;case 24:return this.popState(),this.pushState("CLASSDEFID"),"DEFAULT_CLASSDEF_ID";case 25:return this.popState(),this.pushState("CLASSDEFID"),42;case 26:return this.popState(),43;case 27:return this.pushState("CLASS"),48;case 28:return this.popState(),this.pushState("CLASS_STYLE"),49;case 29:return this.popState(),50;case 30:return this.pushState("STYLE"),45;case 31:return this.popState(),this.pushState("STYLEDEF_STYLES"),46;case 32:return this.popState(),47;case 33:return this.pushState("SCALE"),17;case 34:return 18;case 35:this.popState();break;case 36:this.pushState("STATE");break;case 37:return this.popState(),a.yytext=a.yytext.slice(0,-8).trim(),25;case 38:return this.popState(),a.yytext=a.yytext.slice(0,-8).trim(),26;case 39:return this.popState(),a.yytext=a.yytext.slice(0,-10).trim(),27;case 40:return this.popState(),a.yytext=a.yytext.slice(0,-8).trim(),25;case 41:return this.popState(),a.yytext=a.yytext.slice(0,-8).trim(),26;case 42:return this.popState(),a.yytext=a.yytext.slice(0,-10).trim(),27;case 43:return 51;case 44:return 52;case 45:return 53;case 46:return 54;case 47:this.pushState("STATE_STRING");break;case 48:return this.pushState("STATE_ID"),"AS";case 49:return i()?(this.popState(),"ID"):void 0;case 50:this.popState();break;case 51:return"STATE_DESCR";case 52:throw new Error('Error: State name must be a single word. Found: "'+a.yytext.trim()+'"');case 53:return 19;case 54:this.popState();break;case 55:return this.popState(),this.pushState("struct"),20;case 56:return this.popState(),21;case 57:break;case 58:return this.begin("NOTE"),29;case 59:return this.popState(),this.pushState("NOTE_ID"),59;case 60:return this.popState(),this.pushState("NOTE_ID"),60;case 61:this.popState(),this.pushState("FLOATING_NOTE");break;case 62:return this.popState(),this.pushState("FLOATING_NOTE_ID"),"AS";case 63:break;case 64:return"NOTE_TEXT";case 65:return i()?(this.popState(),"ID"):void 0;case 66:return i()?(this.popState(),this.pushState("NOTE_TEXT"),24):void 0;case 67:return this.popState(),a.yytext=a.yytext.substr(2).trim(),31;case 68:return this.popState(),a.yytext=a.yytext.slice(0,-8).trim(),31;case 69:return 6;case 70:return 6;case 71:return 16;case 72:return 57;case 73:return i()?24:void 0;case 74:return a.yytext=a.yytext.trim(),14;case 75:return 15;case 76:return 28;case 77:return 58;case 78:return 5;case 79:return"INVALID"}},"anonymous"),rules:[/^(?:click\b)/i,/^(?:href\b)/i,/^(?:"[^"]*")/i,/^(?:default\b)/i,/^(?:.*direction\s+TB[^\n]*)/i,/^(?:.*direction\s+BT[^\n]*)/i,/^(?:.*direction\s+RL[^\n]*)/i,/^(?:.*direction\s+LR[^\n]*)/i,/^(?:[\n]+)/i,/^(?:[\s]+)/i,/^(?:((?!\n)\s)+)/i,/^(?:#[^\n]*)/i,/^(?:%%(?!\{)[^\n]*)/i,/^(?:scale\s+)/i,/^(?:\d+)/i,/^(?:\s+width\b)/i,/^(?:accTitle\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*\{\s*)/i,/^(?:[\}])/i,/^(?:[^\}]*)/i,/^(?:classDef\s+)/i,/^(?:DEFAULT\s+)/i,/^(?:\w+\s+)/i,/^(?:[^\n]*)/i,/^(?:class\s+)/i,/^(?:(\w+)+((,\s*\w+)*))/i,/^(?:[^\n]*)/i,/^(?:style\s+)/i,/^(?:[\w,]+\s+)/i,/^(?:[^\n]*)/i,/^(?:scale\s+)/i,/^(?:\d+)/i,/^(?:\s+width\b)/i,/^(?:state\s+)/i,/^(?:.*<<fork>>)/i,/^(?:.*<<join>>)/i,/^(?:.*<<choice>>)/i,/^(?:.*\[\[fork\]\])/i,/^(?:.*\[\[join\]\])/i,/^(?:.*\[\[choice\]\])/i,/^(?:.*direction\s+TB[^\n]*)/i,/^(?:.*direction\s+BT[^\n]*)/i,/^(?:.*direction\s+RL[^\n]*)/i,/^(?:.*direction\s+LR[^\n]*)/i,/^(?:["])/i,/^(?:\s*as\s+)/i,/^(?:[^\n\{]*)/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:\w+\s+\w+.*?\{)/i,/^(?:[^\n\s\{]+)/i,/^(?:\n)/i,/^(?:\{)/i,/^(?:\})/i,/^(?:[\n])/i,/^(?:note\s+)/i,/^(?:left of\b)/i,/^(?:right of\b)/i,/^(?:")/i,/^(?:\s*as\s*)/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:[^\n]*)/i,/^(?:\s*[^:\n\s\-]+)/i,/^(?:\s*:[^:\n;]+)/i,/^(?:[\s\S]*?\n\s*end note\b)/i,/^(?:stateDiagram\s+)/i,/^(?:stateDiagram-v2\s+)/i,/^(?:hide empty description\b)/i,/^(?:\[\*\])/i,/^(?:[^:\n\s\-\{]+)/i,/^(?:\s*:(?:[^:\n;]|:[^:\n;])+)/i,/^(?:-->)/i,/^(?:--)/i,/^(?::::)/i,/^(?:$)/i,/^(?:.)/i],conditions:{LINE:{rules:[10,11,12],inclusive:!1},struct:{rules:[10,11,12,23,27,30,36,43,44,45,46,56,57,58,72,73,74,75,76,77],inclusive:!1},FLOATING_NOTE_ID:{rules:[65],inclusive:!1},FLOATING_NOTE:{rules:[62,63,64],inclusive:!1},NOTE_TEXT:{rules:[67,68],inclusive:!1},NOTE_ID:{rules:[66],inclusive:!1},NOTE:{rules:[59,60,61],inclusive:!1},STYLEDEF_STYLEOPTS:{rules:[],inclusive:!1},STYLEDEF_STYLES:{rules:[32],inclusive:!1},STYLE_IDS:{rules:[],inclusive:!1},STYLE:{rules:[31],inclusive:!1},CLASS_STYLE:{rules:[29],inclusive:!1},CLASS:{rules:[28],inclusive:!1},CLASSDEFID:{rules:[26],inclusive:!1},CLASSDEF:{rules:[24,25],inclusive:!1},acc_descr_multiline:{rules:[21,22],inclusive:!1},acc_descr:{rules:[19],inclusive:!1},acc_title:{rules:[17],inclusive:!1},SCALE:{rules:[14,15,34,35],inclusive:!1},ALIAS:{rules:[],inclusive:!1},STATE_ID:{rules:[49],inclusive:!1},STATE_STRING:{rules:[50,51],inclusive:!1},FORK_STATE:{rules:[],inclusive:!1},STATE:{rules:[10,11,12,37,38,39,40,41,42,47,48,52,53,54,55],inclusive:!1},ID:{rules:[10,11,12],inclusive:!1},INITIAL:{rules:[0,1,2,3,4,5,6,7,8,9,11,12,13,16,18,20,23,27,30,33,36,55,58,69,70,71,72,73,74,75,77,78,79],inclusive:!0}}};return V}();gt.lexer=Qt;function ht(){this.yy={}}return p(ht,"Parser"),ht.prototype=gt,gt.Parser=ht,new ht}();Ct.parser=Ct;var We=Ct,Se="TB",Yt="TB",Nt="dir",Q="state",q="root",At="relation",ye="classDef",ge="style",Te="applyClass",st="default",Gt="divider",Vt="fill:none",Mt="fill: #333",Ut="c",Wt="markdown",jt="normal",Dt="rect",vt="rectWithTitle",Ee="stateStart",_e="stateEnd",Ot="divider",Rt="roundedWithTitle",me="note",be="noteGroup",it="statediagram",ke="state",De=`${it}-${ke}`,Ht="transition",ve="note",Ce="note-edge",Ae=`${Ht} ${Ce}`,xe=`${it}-${ve}`,Le="cluster",Ie=`${it}-${Le}`,we="cluster-alt",Ne=`${it}-${we}`,zt="parent",Kt="note",Oe="state",xt="----",Re=`${xt}${Kt}`,$t=`${xt}${zt}`,Xt=p((t,e=Yt)=>{if(!t.doc)return e;let s=e;for(const n of t.doc)n.stmt==="dir"&&(s=n.value);return s},"getDir"),$e=p(function(t,e){return e.db.getClasses()},"getClasses"),Fe=p(async function(t,e,s,n){b.info("REF0:"),b.info("Drawing state diagram (v2)",e);const{securityLevel:r,state:c,layout:u}=$();n.db.extract(n.db.getRootDocV2());const S=n.db.getData(),d=ee(e,r);S.type=n.type,S.layoutAlgorithm=u,S.nodeSpacing=c?.nodeSpacing||50,S.rankSpacing=c?.rankSpacing||50,$().look==="neo"?S.markers=["barbNeo"]:S.markers=["barb"],S.diagramId=e,await ie(S,d);const E=8;try{(typeof n.db.getLinks=="function"?n.db.getLinks():new Map).forEach((L,D)=>{const f=typeof D=="string"?D:typeof D?.id=="string"?D.id:"",I=S.nodes.find(w=>w.id===f);if(!f){b.warn("⚠️ Invalid or missing stateId from key:",JSON.stringify(D));return}const R=d.node()?.querySelectorAll("g.node, g.rough-node");let C;if(R?.forEach(w=>{const z=w.textContent?.trim();(w.id===I?.domId||z===f)&&(C=w)}),!C){b.warn("⚠️ Could not find node matching text:",f);return}const F=C.parentNode;if(!F){b.warn("⚠️ Node has no parent, cannot wrap:",f);return}const A=document.createElementNS("http://www.w3.org/2000/svg","a"),P=L.url.replace(/^"+|"+$/g,"");if(A.setAttributeNS("http://www.w3.org/1999/xlink","xlink:href",P),A.setAttribute("target","_blank"),L.tooltip){const w=L.tooltip.replace(/^"+|"+$/g,"");A.setAttribute("title",w),C.setAttribute("title",w)}F.replaceChild(A,C),A.appendChild(C),b.info("🔗 Wrapped node in <a> tag for:",f,L.url)})}catch(m){b.error("❌ Error injecting clickable links:",m)}re.insertTitle(d,"statediagramTitleText",c?.titleTopMargin??25,n.db.getDiagramTitle()),se(d,E,it,c?.useMaxWidth??!0)},"draw"),je={getClasses:$e,draw:Fe,getDir:Xt},St=new Map,M=0;function yt(t="",e=0,s="",n=xt){const r=s!==null&&s.length>0?`${n}${s}`:"";return`${Oe}-${t}${r}-${e}`}p(yt,"stateDomId");var Pe=p((t,e,s,n,r,c,u,S)=>{b.trace("items",e),e.forEach(d=>{switch(d.stmt){case Q:et(t,d,s,n,r,c,u,S);break;case st:et(t,d,s,n,r,c,u,S);break;case At:{et(t,d.state1,s,n,r,c,u,S),et(t,d.state2,s,n,r,c,u,S);const T=u==="neo",E={id:"edge"+M,start:d.state1.id,end:d.state2.id,arrowhead:"normal",arrowTypeEnd:T?"arrow_barb_neo":"arrow_barb",style:Vt,labelStyle:"",label:j.sanitizeText(d.description??"",$()),arrowheadStyle:Mt,labelpos:Ut,labelType:Wt,thickness:jt,classes:Ht,look:u};r.push(E),M++}break}})},"setupDoc"),Ft=p((t,e=Yt)=>{let s=e;if(t.doc)for(const n of t.doc)n.stmt==="dir"&&(s=n.value);return s},"getDir");function tt(t,e,s){if(!e.id||e.id==="</join></fork>"||e.id==="</choice>")return;e.cssClasses&&(Array.isArray(e.cssCompiledStyles)||(e.cssCompiledStyles=[]),e.cssClasses.split(" ").forEach(r=>{const c=s.get(r);c&&(e.cssCompiledStyles=[...e.cssCompiledStyles??[],...c.styles])}));const n=t.find(r=>r.id===e.id);n?Object.assign(n,e):t.push(e)}p(tt,"insertOrUpdateNode");function Jt(t){return t?.classes?.join(" ")??""}p(Jt,"getClassesFromDbInfo");function qt(t){return t?.styles??[]}p(qt,"getStylesFromDbInfo");var et=p((t,e,s,n,r,c,u,S)=>{const d=e.id,T=s.get(d),E=Jt(T),m=qt(T),L=$();if(b.info("dataFetcher parsedItem",e,T,m),d!=="root"){let D=Dt;e.start===!0?D=Ee:e.start===!1&&(D=_e),e.type!==st&&(D=e.type),St.get(d)||St.set(d,{id:d,shape:D,description:j.sanitizeText(d,L),cssClasses:`${E} ${De}`,cssStyles:m});const f=St.get(d);e.description&&(Array.isArray(f.description)?(f.shape=vt,f.description.push(e.description)):f.description?.length&&f.description.length>0?(f.shape=vt,f.description===d?f.description=[e.description]:f.description=[f.description,e.description]):(f.shape=Dt,f.description=e.description),f.description=j.sanitizeTextOrArray(f.description,L)),f.description?.length===1&&f.shape===vt&&(f.type==="group"?f.shape=Rt:f.shape=Dt),!f.type&&e.doc&&(b.info("Setting cluster for XCX",d,Ft(e)),f.type="group",f.isGroup=!0,f.dir=Ft(e),f.shape=e.type===Gt?Ot:Rt,f.cssClasses=`${f.cssClasses} ${Ie} ${c?Ne:""}`);const I={labelStyle:"",shape:f.shape,label:f.description,cssClasses:f.cssClasses,cssCompiledStyles:[],cssStyles:f.cssStyles,id:d,dir:f.dir,domId:yt(d,M),type:f.type,isGroup:f.type==="group",padding:8,rx:10,ry:10,look:u,labelType:"markdown"};if(I.shape===Ot&&(I.label=""),t&&t.id!=="root"&&(b.trace("Setting node ",d," to be child of its parent ",t.id),I.parentId=t.id),I.centerLabel=!0,e.note){const R={labelStyle:"",shape:me,label:e.note.text,labelType:"markdown",cssClasses:xe,cssStyles:[],cssCompiledStyles:[],id:d+Re+"-"+M,domId:yt(d,M,Kt),type:f.type,isGroup:f.type==="group",padding:L.flowchart?.padding,look:u,position:e.note.position},C=d+$t,F={labelStyle:"",shape:be,label:e.note.text,cssClasses:f.cssClasses,cssStyles:[],id:d+$t,domId:yt(d,M,zt),type:"group",isGroup:!0,padding:16,look:u,position:e.note.position};M++,F.id=C,R.parentId=C,tt(n,F,S),tt(n,R,S),tt(n,I,S);let A=d,P=R.id;e.note.position==="left of"&&(A=R.id,P=d),r.push({id:A+"-"+P,start:A,end:P,arrowhead:"none",arrowTypeEnd:"",style:Vt,labelStyle:"",classes:Ae,arrowheadStyle:Mt,labelpos:Ut,labelType:Wt,thickness:jt,look:u})}else tt(n,I,S)}e.doc&&(b.trace("Adding nodes children "),Pe(e,e.doc,s,n,r,!c,u,S))},"dataFetcher"),Be=p(()=>{St.clear(),M=0},"reset"),v={START_NODE:"[*]",START_TYPE:"start",END_NODE:"[*]",END_TYPE:"end",COLOR_KEYWORD:"color",FILL_KEYWORD:"fill",BG_FILL:"bgFill",STYLECLASS_SEP:","},Pt=p(()=>new Map,"newClassesList"),Bt=p(()=>({relations:[],states:new Map,documents:{}}),"newDoc"),pt=p(t=>JSON.parse(JSON.stringify(t)),"clone"),H,He=(H=class{constructor(e){this.version=e,this.nodes=[],this.edges=[],this.rootDoc=[],this.classes=Pt(),this.documents={root:Bt()},this.currentDocument=this.documents.root,this.startEndCount=0,this.dividerCnt=0,this.links=new Map,this.funs=[],this.getAccTitle=ae,this.setAccTitle=ne,this.getAccDescription=oe,this.setAccDescription=le,this.setDiagramTitle=ce,this.getDiagramTitle=he,this.clear(),this.setRootDoc=this.setRootDoc.bind(this),this.getDividerId=this.getDividerId.bind(this),this.setDirection=this.setDirection.bind(this),this.trimColon=this.trimColon.bind(this),this.bindFunctions=this.bindFunctions.bind(this)}extract(e){this.clear(!0);for(const r of Array.isArray(e)?e:e.doc)switch(r.stmt){case Q:this.addState(r.id.trim(),r.type,r.doc,r.description,r.note);break;case At:this.addRelation(r.state1,r.state2,r.description);break;case ye:this.addStyleClass(r.id.trim(),r.classes);break;case ge:this.handleStyleDef(r);break;case Te:this.setCssClass(r.id.trim(),r.styleClass);break;case"click":this.addLink(r.id,r.url,r.tooltip);break}const s=this.getStates(),n=$();Be(),et(void 0,this.getRootDocV2(),s,this.nodes,this.edges,!0,n.look,this.classes);for(const r of this.nodes)if(Array.isArray(r.label)){if(r.description=r.label.slice(1),r.isGroup&&r.description.length>0)throw new Error(`Group nodes can only have label. Remove the additional description for node [${r.id}]`);r.label=r.label[0]}}handleStyleDef(e){const s=e.id.trim().split(","),n=e.styleClass.split(",");for(const r of s){let c=this.getState(r);if(!c){const u=r.trim();this.addState(u),c=this.getState(u)}c&&(c.styles=n.map(u=>u.replace(/;/g,"")?.trim()))}}setRootDoc(e){b.info("Setting root doc",e),this.rootDoc=e,this.version===1?this.extract(e):this.extract(this.getRootDocV2())}docTranslator(e,s,n){if(s.stmt===At){this.docTranslator(e,s.state1,!0),this.docTranslator(e,s.state2,!1);return}if(s.stmt===Q&&(s.id===v.START_NODE?(s.id=e.id+(n?"_start":"_end"),s.start=n):s.id=s.id.trim()),s.stmt!==q&&s.stmt!==Q||!s.doc)return;const r=[];let c=[];for(const u of s.doc)if(u.type===Gt){const S=pt(u);S.doc=pt(c),r.push(S),c=[]}else c.push(u);if(r.length>0&&c.length>0){const u={stmt:Q,id:ue(),type:"divider",doc:pt(c)};r.push(pt(u)),s.doc=r}s.doc.forEach(u=>this.docTranslator(s,u,!0))}getRootDocV2(){return this.docTranslator({id:q,stmt:q},{id:q,stmt:q,doc:this.rootDoc},!0),{id:q,doc:this.rootDoc}}addState(e,s=st,n=void 0,r=void 0,c=void 0,u=void 0,S=void 0,d=void 0){const T=e?.trim();if(!this.currentDocument.states.has(T))b.info("Adding state ",T,r),this.currentDocument.states.set(T,{stmt:Q,id:T,descriptions:[],type:s,doc:n,note:c,classes:[],styles:[],textStyles:[]});else{const E=this.currentDocument.states.get(T);if(!E)throw new Error(`State not found: ${T}`);E.doc||(E.doc=n),E.type||(E.type=s)}if(r&&(b.info("Setting state description",T,r),(Array.isArray(r)?r:[r]).forEach(m=>this.addDescription(T,m.trim()))),c){const E=this.currentDocument.states.get(T);if(!E)throw new Error(`State not found: ${T}`);E.note=c,E.note.text=j.sanitizeText(E.note.text,$())}u&&(b.info("Setting state classes",T,u),(Array.isArray(u)?u:[u]).forEach(m=>this.setCssClass(T,m.trim()))),S&&(b.info("Setting state styles",T,S),(Array.isArray(S)?S:[S]).forEach(m=>this.setStyle(T,m.trim()))),d&&(b.info("Setting state styles",T,S),(Array.isArray(d)?d:[d]).forEach(m=>this.setTextStyle(T,m.trim())))}clear(e){this.nodes=[],this.edges=[],this.funs=[this.setupToolTips.bind(this)],this.documents={root:Bt()},this.currentDocument=this.documents.root,this.startEndCount=0,this.classes=Pt(),e||(this.links=new Map,de())}getState(e){return this.currentDocument.states.get(e)}getStates(){return this.currentDocument.states}logDocuments(){b.info("Documents = ",this.documents)}getRelations(){return this.currentDocument.relations}addLink(e,s,n){this.links.set(e,{url:s,tooltip:n}),b.warn("Adding link",e,s,n)}getLinks(){return this.links}startIdIfNeeded(e=""){return e===v.START_NODE?(this.startEndCount++,`${v.START_TYPE}${this.startEndCount}`):e}startTypeIfNeeded(e="",s=st){return e===v.START_NODE?v.START_TYPE:s}endIdIfNeeded(e=""){return e===v.END_NODE?(this.startEndCount++,`${v.END_TYPE}${this.startEndCount}`):e}endTypeIfNeeded(e="",s=st){return e===v.END_NODE?v.END_TYPE:s}addRelationObjs(e,s,n=""){const r=this.startIdIfNeeded(e.id.trim()),c=this.startTypeIfNeeded(e.id.trim(),e.type),u=this.startIdIfNeeded(s.id.trim()),S=this.startTypeIfNeeded(s.id.trim(),s.type);this.addState(r,c,e.doc,e.description,e.note,e.classes,e.styles,e.textStyles),this.addState(u,S,s.doc,s.description,s.note,s.classes,s.styles,s.textStyles),this.currentDocument.relations.push({id1:r,id2:u,relationTitle:j.sanitizeText(n,$())})}addRelation(e,s,n){if(typeof e=="object"&&typeof s=="object")this.addRelationObjs(e,s,n);else if(typeof e=="string"&&typeof s=="string"){const r=this.startIdIfNeeded(e.trim()),c=this.startTypeIfNeeded(e),u=this.endIdIfNeeded(s.trim()),S=this.endTypeIfNeeded(s);this.addState(r,c),this.addState(u,S),this.currentDocument.relations.push({id1:r,id2:u,relationTitle:n?j.sanitizeText(n,$()):void 0})}}addDescription(e,s){const n=this.currentDocument.states.get(e),r=s.startsWith(":")?s.replace(":","").trim():s;n?.descriptions?.push(j.sanitizeText(r,$()))}cleanupLabel(e){return e.startsWith(":")?e.slice(2).trim():e.trim()}getDividerId(){return this.dividerCnt++,`divider-id-${this.dividerCnt}`}addStyleClass(e,s=""){this.classes.has(e)||this.classes.set(e,{id:e,styles:[],textStyles:[]});const n=this.classes.get(e);s&&n&&s.split(v.STYLECLASS_SEP).forEach(r=>{const c=r.replace(/([^;]*);/,"$1").trim();if(RegExp(v.COLOR_KEYWORD).exec(r)){const S=c.replace(v.FILL_KEYWORD,v.BG_FILL).replace(v.COLOR_KEYWORD,v.FILL_KEYWORD);n.textStyles.push(S)}n.styles.push(c)})}getClasses(){return this.classes}setupToolTips(e){const s=pe();kt(e).select("svg").selectAll("g.node, g.rough-node").on("mouseover",c=>{const u=kt(c.currentTarget),S=u.attr("title");if(S===null)return;const d=c.currentTarget?.getBoundingClientRect();s.transition().duration(200).style("opacity",".9"),s.style("left",window.scrollX+d.left+(d.right-d.left)/2+"px").style("top",window.scrollY+d.bottom+"px"),s.html(fe.sanitize(S)),u.classed("hover",!0)}).on("mouseout",c=>{s.transition().duration(500).style("opacity",0),kt(c.currentTarget).classed("hover",!1)})}setCssClass(e,s){e.split(",").forEach(n=>{let r=this.getState(n);if(!r){const c=n.trim();this.addState(c),r=this.getState(c)}r?.classes?.push(s)})}setStyle(e,s){this.getState(e)?.styles?.push(s)}setTextStyle(e,s){this.getState(e)?.textStyles?.push(s)}bindFunctions(e){this.funs.forEach(s=>{s(e)})}getDirectionStatement(){return this.rootDoc.find(e=>e.stmt===Nt)}getDirection(){return this.getDirectionStatement()?.value??Se}setDirection(e){const s=this.getDirectionStatement();s?s.value=e:this.rootDoc.unshift({stmt:Nt,value:e})}trimColon(e){return e.startsWith(":")?e.slice(1).trim():e.trim()}getData(){const e=$();return{nodes:this.nodes,edges:this.edges,other:{},config:e,direction:Xt(this.getRootDocV2())}}getConfig(){return $().state}},p(H,"StateDB"),H.relationType={AGGREGATION:0,EXTENSION:1,COMPOSITION:2,DEPENDENCY:3},H),Ye=p(t=>`
defs [id$="-barbEnd"] {
    fill: ${t.transitionColor};
    stroke: ${t.transitionColor};
  }
g.stateGroup text {
  fill: ${t.nodeBorder};
  stroke: none;
  font-size: 10px;
}
g.stateGroup text {
  fill: ${t.textColor};
  stroke: none;
  font-size: 10px;

}
g.stateGroup .state-title {
  font-weight: bolder;
  fill: ${t.stateLabelColor};
}

g.stateGroup rect {
  fill: ${t.mainBkg};
  stroke: ${t.nodeBorder};
}

g.stateGroup line {
  stroke: ${t.lineColor};
  stroke-width: ${t.strokeWidth||1};
}

.transition {
  stroke: ${t.transitionColor};
  stroke-width: ${t.strokeWidth||1};
  fill: none;
}

.stateGroup .composit {
  fill: ${t.background};
  border-bottom: 1px
}

.stateGroup .alt-composit {
  fill: #e0e0e0;
  border-bottom: 1px
}

.state-note {
  stroke: ${t.noteBorderColor};
  fill: ${t.noteBkgColor};

  text {
    fill: ${t.noteTextColor};
    stroke: none;
    font-size: 10px;
  }
}

.stateLabel .box {
  stroke: none;
  stroke-width: 0;
  fill: ${t.mainBkg};
  opacity: 0.5;
}

.edgeLabel .label rect {
  fill: ${t.labelBackgroundColor};
  opacity: 0.5;
}
.edgeLabel {
  background-color: ${t.edgeLabelBackground};
  p {
    background-color: ${t.edgeLabelBackground};
  }
  rect {
    opacity: 0.5;
    background-color: ${t.edgeLabelBackground};
    fill: ${t.edgeLabelBackground};
  }
  text-align: center;
}
.edgeLabel .label text {
  fill: ${t.transitionLabelColor||t.tertiaryTextColor};
}
.label div .edgeLabel {
  color: ${t.transitionLabelColor||t.tertiaryTextColor};
}

.stateLabel text {
  fill: ${t.stateLabelColor};
  font-size: 10px;
  font-weight: bold;
}

.node circle.state-start {
  fill: ${t.specialStateColor};
  stroke: ${t.specialStateColor};
}

.node .fork-join {
  fill: ${t.specialStateColor};
  stroke: ${t.specialStateColor};
}

.node circle.state-end {
  fill: ${t.innerEndBackground};
  stroke: ${t.background};
  stroke-width: 1.5
}
.end-state-inner {
  fill: ${t.compositeBackground||t.background};
  // stroke: ${t.background};
  stroke-width: 1.5
}

.node rect {
  fill: ${t.stateBkg||t.mainBkg};
  stroke: ${t.stateBorder||t.nodeBorder};
  stroke-width: ${t.strokeWidth||1}px;
}
.node polygon {
  fill: ${t.mainBkg};
  stroke: ${t.stateBorder||t.nodeBorder};;
  stroke-width: ${t.strokeWidth||1}px;
}
[id$="-barbEnd"] {
  fill: ${t.lineColor};
}

.statediagram-cluster rect {
  fill: ${t.compositeTitleBackground};
  stroke: ${t.stateBorder||t.nodeBorder};
  stroke-width: ${t.strokeWidth||1}px;
}

.cluster-label, .nodeLabel {
  color: ${t.stateLabelColor};
  // line-height: 1;
}

.statediagram-cluster rect.outer {
  rx: 5px;
  ry: 5px;
}
.statediagram-state .divider {
  stroke: ${t.stateBorder||t.nodeBorder};
}

.statediagram-state .title-state {
  rx: 5px;
  ry: 5px;
}
.statediagram-cluster.statediagram-cluster .inner {
  fill: ${t.compositeBackground||t.background};
}
.statediagram-cluster.statediagram-cluster-alt .inner {
  fill: ${t.altBackground?t.altBackground:"#efefef"};
}

.statediagram-cluster .inner {
  rx:0;
  ry:0;
}

.statediagram-state rect.basic {
  rx: 5px;
  ry: 5px;
}
.statediagram-state rect.divider {
  stroke-dasharray: 10,10;
  fill: ${t.altBackground?t.altBackground:"#efefef"};
}

.note-edge {
  stroke-dasharray: 5;
}

.statediagram-note rect {
  fill: ${t.noteBkgColor};
  stroke: ${t.noteBorderColor};
  stroke-width: 1px;
  rx: 0;
  ry: 0;
}
.statediagram-note rect {
  fill: ${t.noteBkgColor};
  stroke: ${t.noteBorderColor};
  stroke-width: 1px;
  rx: 0;
  ry: 0;
}

.statediagram-note text {
  fill: ${t.noteTextColor};
}

.statediagram-note .nodeLabel {
  color: ${t.noteTextColor};
}
.statediagram .edgeLabel {
  color: red; // ${t.noteTextColor};
}

[id$="-dependencyStart"], [id$="-dependencyEnd"] {
  fill: ${t.lineColor};
  stroke: ${t.lineColor};
  stroke-width: ${t.strokeWidth||1};
}

.statediagramTitleText {
  text-anchor: middle;
  font-size: 18px;
  fill: ${t.textColor};
}

[data-look="neo"].statediagram-cluster rect {
  fill: ${t.mainBkg};
  stroke: ${t.useGradient?"url("+t.svgId+"-gradient)":t.stateBorder||t.nodeBorder};
  stroke-width: ${t.strokeWidth??1};
}
[data-look="neo"].statediagram-cluster rect.outer {
  rx: ${t.radius}px;
  ry: ${t.radius}px;
  filter: ${t.dropShadow?t.dropShadow.replace("url(#drop-shadow)",`url(${t.svgId}-drop-shadow)`):"none"}
}
`,"getStyles"),ze=Ye;export{He as S,We as a,je as b,ze as s};
