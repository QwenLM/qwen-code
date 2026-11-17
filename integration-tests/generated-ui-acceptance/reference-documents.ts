/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hand-written `generated_ui_show` documents for the deterministic replay
 * mode. Each one implements its acceptance case as far as the current `ui.*`
 * API allows, following the harness contract in `cases.ts` (element IDs). The
 * replay then measures what the runtime and host can do today, independent of
 * any model's generation quality.
 *
 * Where the API has no mechanism (clipboard, download, persisted state), the
 * document still provides the contract's control, so the check observes the
 * missing capability instead of a missing element.
 */

export interface GeneratedUiDocument {
  title: string;
  summary: string;
  html: string;
  css: string;
  javascript: string;
}

const MONEY_JS = `
function cents(value){var n=Number(value);return Number.isFinite(n)?Math.round(n*100):NaN;}
function money(c){var s=c<0?'-':'';c=Math.abs(c);return s+Math.floor(c/100)+'.'+String(c%100).padStart(2,'0');}
`;

export const billSplitterDocument: GeneratedUiDocument = {
  title: 'Dinner bill splitter',
  summary:
    'Six people, food subtotal CNY 900, CNY 60 discount, 10% service fee on the discounted amount: total CNY 924.00, CNY 154.00 each. Leftover cents go to the first people so the shares always add up to the total.',
  html:
    '<section class="grid">' +
    '<label for="subtotal">Food subtotal (CNY)</label><input id="subtotal" type="number" min="0" step="0.01" value="900">' +
    '<label for="people">People</label><input id="people" type="number" min="1" max="20" step="1" value="6">' +
    '<label for="discount">Discount (CNY)</label><input id="discount" type="number" min="0" step="0.01" value="60">' +
    '<label for="service-rate">Service fee (%)</label><input id="service-rate" type="number" min="0" max="100" step="0.1" value="10">' +
    '</section>' +
    '<p role="alert" id="error" class="danger"></p>' +
    '<p>Total: <output id="total"></output></p>' +
    '<ul id="shares"></ul><div id="chart" role="img" aria-label="Share per person"></div>' +
    '<button id="reset" type="button">Reset</button> <button id="copy" type="button">Copy current values</button>' +
    '<p id="copy-status" class="muted"></p>',
  css: '#chart svg{width:100%;height:auto}',
  javascript:
    MONEY_JS +
    `
var DEFAULTS={subtotal:'900',people:'6',discount:'60','service-rate':'10'};
function read(){
  var subtotal=cents(ui.input('subtotal').value), discount=cents(ui.input('discount').value);
  var people=Number(ui.input('people').value), rate=Number(ui.input('service-rate').value);
  if(!(subtotal>=0)) return {error:'Subtotal must be zero or more.'};
  if(!(Number.isInteger(people)&&people>=1&&people<=20)) return {error:'People must be a whole number from 1 to 20.'};
  if(!(discount>=0&&discount<=subtotal)) return {error:'Discount must be between 0 and the subtotal.'};
  if(!(rate>=0&&rate<=100)) return {error:'Service fee must be between 0% and 100%.'};
  var total=Math.round((subtotal-discount)*(100+rate)/100);
  var base=Math.floor(total/people), extra=total-base*people, shares=[];
  for(var i=0;i<people;i++) shares.push(i<extra?base+1:base);
  return {total:total,shares:shares};
}
function render(){
  var r=read();
  if(r.error){ui.text('error',r.error);ui.text('total','—');ui.html('shares','');ui.html('chart','');return;}
  ui.text('error','');
  ui.text('total','CNY '+money(r.total));
  var items='', bars='', max=r.shares[0];
  for(var i=0;i<r.shares.length;i++){
    items+='<li id="share-'+(i+1)+'">Person '+(i+1)+': CNY '+money(r.shares[i])+'</li>';
    var h=Math.round(80*r.shares[i]/max);
    bars+='<rect x="'+(i*30+5)+'" y="'+(90-h)+'" width="20" height="'+h+'"></rect>';
  }
  ui.html('shares',items);
  ui.html('chart','<svg viewBox="0 0 '+(r.shares.length*30+10)+' 100"><title>Share per person</title>'+bars+'</svg>');
}
['subtotal','people','discount','service-rate'].forEach(function(id){ui.on(id,'input',render);});
ui.on('reset','click',function(){Object.keys(DEFAULTS).forEach(function(id){ui.value(id,DEFAULTS[id]);});render();});
ui.on('copy','click',function(){ui.text('copy-status','Copying is not available in this view.');});
render();
`,
};

export const checklistDocument: GeneratedUiDocument = {
  title: 'Meeting checklist',
  summary:
    'A checklist for the meeting with add, edit, check, delete, filter and undo. It starts empty.',
  html:
    '<label for="new-item">New item</label><input id="new-item" type="text" maxlength="80">' +
    '<button id="add" type="button">Add</button> ' +
    '<label for="filter">Show</label><select id="filter"><option value="all">All</option><option value="open">Open</option><option value="done">Done</option></select> ' +
    '<button id="undo" type="button">Undo</button>' +
    '<p id="empty">No items yet.</p><ul id="items">' +
    Array.from(
      { length: 8 },
      (_, index) => `<li id="item-${index + 1}"></li>`,
    ).join('') +
    '</ul>',
  css: '#items{list-style:none;padding:0}',
  javascript: `
// Fixed row slots: handlers can only be registered at initialization.
var SLOTS=8, items=[], history=[];
function snapshot(){history.push(JSON.stringify(items));if(history.length>20)history.shift();}
function render(){
  var filter=ui.input('filter').value, shown=0;
  for(var i=0;i<SLOTS;i++){
    var item=items[i], id='item-'+(i+1);
    var visible=!!item&&(filter==='all'||(filter==='done')===item.done);
    ui.html(id, visible?'<input id="'+id+'-check" type="checkbox"'+(item.done?' checked':'')+'><input id="'+id+'-text" type="text" maxlength="80" aria-label="Item text"><button id="'+id+'-delete" type="button">Delete</button>':'');
    if(visible){ui.value(id+'-text',item.text);shown++;}
  }
  ui.text('empty', shown?'':(items.length?'Nothing matches this filter.':'No items yet.'));
}
ui.on('add','click',function(){
  var text=ui.input('new-item').value.trim();
  if(!text||items.length>=SLOTS) return;
  snapshot(); items.push({text:text,done:false}); ui.value('new-item',''); render();
});
for(var s=0;s<SLOTS;s++)(function(i){
  ui.on('item-'+(i+1)+'-check','change',function(e){if(!items[i])return;snapshot();items[i].done=e.checked;render();});
  ui.on('item-'+(i+1)+'-delete','click',function(){if(!items[i])return;snapshot();items.splice(i,1);render();});
  ui.on('item-'+(i+1)+'-text','change',function(e){var text=e.value.trim();if(!items[i]||!text||text===items[i].text)return;snapshot();items[i].text=text;render();});
})(s);
ui.on('filter','change',render);
ui.on('undo','click',function(){if(!history.length)return;items=JSON.parse(history.pop());render();});
render();
`,
};

export const activityFormDocument: GeneratedUiDocument = {
  title: 'Team activity planner',
  summary:
    'Choose an activity, date, number of participants and budget. Nothing is booked; use the continue action to send the current values back to the conversation.',
  html:
    '<label for="activity">Activity</label><select id="activity"><option value="hiking">Hiking</option><option value="bowling">Bowling</option><option value="escape-room">Escape room</option></select>' +
    '<label for="date">Date (YYYY-MM-DD)</label><input id="date" type="text" value="2026-11-20" maxlength="10">' +
    '<label for="participants">Participants</label><input id="participants" type="number" min="1" max="50" value="8">' +
    '<label for="budget">Budget per person (CNY)</label><input id="budget" type="number" min="0" value="150">' +
    '<label for="notes">Notes</label><textarea id="notes" maxlength="200"></textarea>' +
    '<p>Estimated total: <output id="estimate"></output></p>',
  css: '',
  javascript: `
function render(){
  var people=Number(ui.input('participants').value), budget=Number(ui.input('budget').value);
  ui.text('estimate', Number.isFinite(people*budget)?'CNY '+(people*budget).toFixed(2):'—');
}
['activity','date','participants','budget','notes'].forEach(function(id){ui.on(id,'input',render);ui.on(id,'change',render);});
render();
`,
};

/**
 * The comparator. `seats`, `billing`, `plan` and `support` defaults are
 * parameters so the follow-up replay can rebuild the card from the values the
 * conversation carried, as a model would.
 */
export function comparatorDocument(options: {
  seats: number;
  billing: 'monthly' | 'annual';
  plan: 'basic' | 'pro' | 'team';
  withSupport: boolean;
}): GeneratedUiDocument {
  const radio = (
    name: string,
    value: string,
    label: string,
    checked: boolean,
  ) =>
    `<input id="${name}-${value}" type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}><label for="${name}-${value}">${label}</label>`;
  const row = (plan: string, label: string) =>
    `<tr><td>${label}</td><td id="${plan}-monthly"></td><td id="${plan}-payment"></td></tr>`;
  return {
    title: options.withSupport
      ? 'Subscription comparator with support'
      : 'Subscription comparator',
    summary:
      'Basic CNY 39, Pro CNY 69 and Team CNY 99 per seat per month; annual billing takes 20% off the plan price.' +
      (options.withSupport
        ? ' Support adds CNY 12 per seat per month and is never discounted.'
        : ''),
    html:
      '<label for="seats">Seats</label><input id="seats" type="number" min="1" max="500" value="' +
      options.seats +
      '">' +
      '<fieldset><legend>Billing</legend>' +
      radio('billing', 'monthly', 'Monthly', options.billing === 'monthly') +
      radio('billing', 'annual', 'Annual', options.billing === 'annual') +
      '</fieldset><fieldset><legend>Plan</legend>' +
      radio('plan', 'basic', 'Basic', options.plan === 'basic') +
      radio('plan', 'pro', 'Pro', options.plan === 'pro') +
      radio('plan', 'team', 'Team', options.plan === 'team') +
      '</fieldset>' +
      (options.withSupport
        ? '<input id="support" type="checkbox" checked><label for="support">Support</label>'
        : '') +
      '<table><thead><tr><th>Plan</th><th>Per month</th><th>Actual payment</th></tr></thead><tbody>' +
      row('basic', 'Basic') +
      row('pro', 'Pro') +
      row('team', 'Team') +
      '</tbody></table><p id="selected"></p>' +
      '<button id="export" type="button">Export CSV</button><p id="export-status" class="muted"></p>',
    css: '',
    javascript:
      MONEY_JS +
      `
var PRICES={basic:3900,pro:6900,team:9900}, SUPPORT=1200, DISCOUNT=20;
function checked(name, values){for(var i=0;i<values.length;i++){if(ui.input(name+'-'+values[i]).checked)return values[i];}return values[0];}
function render(){
  var seats=Number(ui.input('seats').value);
  if(!(Number.isInteger(seats)&&seats>=1)){ui.text('selected','Seats must be a whole number of at least 1.');return;}
  var billing=checked('billing',['monthly','annual']), plan=checked('plan',['basic','pro','team']);
  var support=${options.withSupport ? "ui.input('support').checked" : 'false'};
  var months=billing==='annual'?12:1;
  Object.keys(PRICES).forEach(function(p){
    var payment=Math.round(PRICES[p]*seats*months*(billing==='annual'?100-DISCOUNT:100)/100+(support?SUPPORT*seats*months:0));
    ui.text(p+'-payment','CNY '+money(payment)+(billing==='annual'?' per year':' per month'));
    ui.text(p+'-monthly','CNY '+money(Math.round(payment/months)));
  });
  ui.text('selected','Selected: '+plan+', '+billing+', '+seats+' seats');
}
['seats','billing-monthly','billing-annual','plan-basic','plan-pro','plan-team'${options.withSupport ? ",'support'" : ''}].forEach(function(id){ui.on(id,'input',render);ui.on(id,'change',render);});
ui.on('export','click',function(){ui.text('export-status','Exporting is not available in this view.');});
render();
`,
  };
}
