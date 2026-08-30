'use strict';
/**
 * 워크플로우 엔진.
 * 스테이지 하나 = "이 세션에게 이 프롬프트를 던지고, 답을 산출물로 받는다".
 * 앞 스테이지의 산출물이 뒤 스테이지의 {{input}} 으로 들어간다.
 * 예) 수집 스테이지(클로드 A) -> 분석 스테이지(제미나이 탭) -> 대본 스테이지(챗지피티 탭)
 */
const store = require('./store');
const adapters = require('./adapters');

// 어댑터 도입 전에 만들어진 작업의 target.type 을 어댑터 id 로 이어준다
const LEGACY_TARGET = {
  'claude-code': 'claude-code',
  app: 'chatgpt-app',
  tab: null, // 탭은 provider 를 봐야 해서 아래에서 따로 푼다
};

const find = (id) => store.state.workflows.find((w) => w.id === id);

function createWorkflow(name) {
  const wf = {
    id: store.uid('wf'),
    name: name || '새 워크플로우',
    createdAt: Date.now(),
    running: false,
    stages: [],
  };
  store.state.workflows.push(wf);
  store.save();
  store.pushState();
  return wf;
}

function addStage(wfId, patch = {}) {
  const wf = find(wfId);
  if (!wf) throw new Error('워크플로우 없음');
  const stage = {
    id: store.uid('st'),
    name: patch.name || `단계 ${wf.stages.length + 1}`,
    target: patch.target || { type: 'manual', ref: null, label: '미배정' },
    prompt: patch.prompt || '',
    auto: patch.auto !== false,
    status: 'pending',
    input: '',
    output: '',
    error: '',
    startedAt: 0,
    endedAt: 0,
  };
  wf.stages.push(stage);
  store.save();
  store.pushState();
  return stage;
}

function updateStage(wfId, stageId, patch) {
  const wf = find(wfId);
  const st = wf && wf.stages.find((s) => s.id === stageId);
  if (!st) throw new Error('단계 없음');
  for (const k of ['name', 'prompt', 'auto', 'target', 'status', 'output', 'input']) {
    if (k in patch) st[k] = patch[k];
  }
  store.save();
  store.pushState();
  return st;
}

function removeStage(wfId, stageId) {
  const wf = find(wfId);
  if (!wf) return;
  wf.stages = wf.stages.filter((s) => s.id !== stageId);
  store.save();
  store.pushState();
}

function removeWorkflow(wfId) {
  store.state.workflows = store.state.workflows.filter((w) => w.id !== wfId);
  store.save();
  store.pushState();
}

/** {{input}}, {{stage:이름}}, {{now}} 치환 */
function render(template, wf, idx) {
  const prev = idx > 0 ? wf.stages[idx - 1] : null;
  return String(template || '')
    .replace(/\{\{\s*input\s*\}\}/g, prev ? prev.output : '')
    .replace(/\{\{\s*stage:([^}]+)\s*\}\}/g, (_, name) => {
      const s = wf.stages.find((x) => x.name.trim() === String(name).trim());
      return s ? s.output : '';
    })
    .replace(/\{\{\s*now\s*\}\}/g, new Date().toLocaleString('ko-KR'));
}

async function dispatch(stage, prompt) {
  const t = stage.target || {};

  // 사람이 처리하는 단계는 여기서 멈춘다
  if (t.type === 'manual') throw new Error('__MANUAL__');

  // 나머지는 전부 어댑터 한 규격으로 간다. 사업자별 차이는 어댑터가 흡수한다.
  let adapterId = t.adapterId || (t.type === 'adapter' ? t.ref : LEGACY_TARGET[t.type]);
  if (!adapterId && t.type === 'tab') {
    adapterId = { claude: 'claude-tab', gemini: 'gemini-tab', chatgpt: 'chatgpt-tab' }[t.provider];
  }
  if (!adapterId) {
    throw new Error('이 단계에 담당이 배정되지 않았습니다');
  }
  const a = adapters.must(adapterId);
  const r = await a.send({ threadId: t.ref, text: prompt });
  return (r && r.text) || '';
}

async function runStage(wfId, stageId) {
  const wf = find(wfId);
  if (!wf) throw new Error('워크플로우 없음');
  const idx = wf.stages.findIndex((s) => s.id === stageId);
  if (idx < 0) throw new Error('단계 없음');
  const stage = wf.stages[idx];

  const prompt = render(stage.prompt, wf, idx);
  stage.input = prompt;
  stage.error = '';
  stage.startedAt = Date.now();
  stage.endedAt = 0;

  try {
    stage.status = 'running';
    store.pushState();
    const output = await dispatch(stage, prompt);
    stage.output = output;
    stage.status = 'done';
    stage.endedAt = Date.now();
    store.save();
    store.pushState();

    // 다음 단계가 자동이면 이어서
    const next = wf.stages[idx + 1];
    if (wf.running && next && next.auto && next.status !== 'running') {
      runStage(wfId, next.id).catch(() => {});
    } else if (!next) {
      wf.running = false;
      store.pushState();
    }
    return output;
  } catch (e) {
    if (e.message === '__MANUAL__') {
      stage.status = 'awaiting-human';
      stage.endedAt = 0;
      store.save();
      store.pushState();
      return null;
    }
    stage.status = 'error';
    stage.error = e.message;
    stage.endedAt = Date.now();
    wf.running = false;
    store.save();
    store.pushState();
    throw e;
  }
}

/** 사람이 수동 단계의 산출물을 채워 넣고 다음으로 넘길 때 */
function completeManual(wfId, stageId, output) {
  const wf = find(wfId);
  const idx = wf.stages.findIndex((s) => s.id === stageId);
  const stage = wf.stages[idx];
  stage.output = output;
  stage.status = 'done';
  stage.endedAt = Date.now();
  store.save();
  store.pushState();
  const next = wf.stages[idx + 1];
  if (wf.running && next && next.auto) runStage(wfId, next.id).catch(() => {});
  return stage;
}

function start(wfId, fromStageId) {
  const wf = find(wfId);
  if (!wf || !wf.stages.length) throw new Error('실행할 단계가 없습니다');
  const from = fromStageId ? wf.stages.findIndex((s) => s.id === fromStageId) : 0;
  wf.running = true;
  for (let i = Math.max(0, from); i < wf.stages.length; i++) {
    const s = wf.stages[i];
    s.status = 'pending'; s.output = ''; s.error = ''; s.startedAt = 0; s.endedAt = 0;
  }
  store.pushState();
  return runStage(wfId, wf.stages[Math.max(0, from)].id);
}

function stop(wfId) {
  const wf = find(wfId);
  if (!wf) return;
  wf.running = false;
  for (const s of wf.stages) {
    if (s.status === 'running' && s.target.type === 'claude-code') runner.cancel(s.target.ref);
    if (s.status === 'running') s.status = 'pending';
  }
  store.save();
  store.pushState();
}

module.exports = {
  createWorkflow, addStage, updateStage, removeStage, removeWorkflow,
  runStage, start, stop, completeManual, find, render,
};
