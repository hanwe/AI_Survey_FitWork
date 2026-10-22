/*
 * Survey engine: question order, jump logic (show_if) and answer checks.
 *
 * The SAME code is used in two places:
 *   - the web page:   web/engine.js
 *   - Apps Script:    Engine.gs
 * If you change one, paste the same content into the other.
 */

var SURVEY_MULTI_SEP = /[、,，;；]/;
var SURVEY_CN_DIGITS = { '一': '1', '二': '2', '兩': '2', '三': '3', '四': '4', '五': '5' };

function surveyItem(survey, id) {
  for (var i = 0; i < survey.items.length; i++) {
    if (survey.items[i].id === id) return survey.items[i];
  }
  return null;
}

function surveyIndex(survey, id) {
  for (var i = 0; i < survey.items.length; i++) {
    if (survey.items[i].id === id) return i;
  }
  return -1;
}

/** True when an item applies, given the answers so far (jump logic). */
function surveyApplies(item, answers) {
  var c = item.show_if;
  if (!c) return true;
  var a = answers[c.item];
  return !!a && a.value === c.equals;
}

function surveySquash_(s) {
  return String(s).replace(/\s+/g, '');
}

function surveyOneOption_(item, raw) {
  var value = String(raw).trim();
  if (item.options.indexOf(value) !== -1) return { value: value };
  for (var i = 0; i < item.options.length; i++) {
    if (surveySquash_(item.options[i]) === surveySquash_(value)) return { value: item.options[i] };
  }
  if (item.allow_other) {
    var v = value.replace(/^其他[：:\s]*/, '');
    if (!v) return { error: '「其他」需要說明內容' };
    return { value: '其他：' + v, other: true };
  }
  return { error: '不是這題的選項' };
}

/** Check one answer and return { value } in the stored format, or { error }. */
function surveyNormalize(item, raw) {
  var value = raw == null ? '' : String(raw).trim();
  if (!value) return { error: '沒有內容' };
  if (item.type === 'text') return { value: value };
  if (item.type === 'rating') {
    value = value
      .replace(/[０-９]/g, function (d) { return String.fromCharCode(d.charCodeAt(0) - 0xfee0); })
      .replace(/[一二兩三四五]/g, function (d) { return SURVEY_CN_DIGITS[d]; })
      .replace(/\s*分$/, '');
  }
  if (item.type === 'multi') {
    var parts = value.split(SURVEY_MULTI_SEP);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      var r = surveyOneOption_(item, p);
      if (r.error) return r;
      if (out.indexOf(r.value) === -1) out.push(r.value);
    }
    return out.length ? { value: out.join('、') } : { error: '沒有內容' };
  }
  return surveyOneOption_(item, value);
}

/** Items in asking order: form order, with ask_last items moved to the end. */
function surveyOrdered(survey) {
  var first = [];
  var last = [];
  for (var i = 0; i < survey.items.length; i++) {
    (survey.items[i].ask_last ? last : first).push(survey.items[i]);
  }
  return first.concat(last);
}

/** The next item to ask, or null when everything is answered or skipped. */
function surveyNext(survey, answers, skipped) {
  skipped = skipped || [];
  var list = surveyOrdered(survey);
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    if (answers[it.id] || skipped.indexOf(it.id) !== -1 || !surveyApplies(it, answers)) continue;
    return it;
  }
  return null;
}

/** Remove answers to items that no longer apply (e.g. problem details after 「沒有」). */
function surveyClean(survey, answers) {
  var out = {};
  var k;
  for (k in answers) if (Object.prototype.hasOwnProperty.call(answers, k)) out[k] = answers[k];
  var changed = true;
  while (changed) {
    changed = false;
    for (k in out) {
      if (!Object.prototype.hasOwnProperty.call(out, k)) continue;
      var it = surveyItem(survey, k);
      if (!it || !surveyApplies(it, out)) {
        delete out[k];
        changed = true;
      }
    }
  }
  return out;
}

/** Required items that apply and are still unanswered. */
function surveyMissingRequired(survey, answers) {
  var out = [];
  for (var i = 0; i < survey.items.length; i++) {
    var it = survey.items[i];
    if (it.required && surveyApplies(it, answers) && !answers[it.id]) out.push(it);
  }
  return out;
}
