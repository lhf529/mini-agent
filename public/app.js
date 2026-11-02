/**
 * 前端逻辑。
 * 安全约定：所有服务端/模型返回的文本一律用 textContent 写入，禁止 innerHTML。
 */

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const clearBtn = document.getElementById('clear');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');

let busy = false;

/** 创建一个元素 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setBusy(value) {
  busy = value;
  sendBtn.disabled = value;
  inputEl.disabled = value;

  if (value) {
    statusEl.hidden = false;
    statusEl.replaceChildren(el('span', 'pulse', '正在思考…'));
  } else {
    statusEl.hidden = true;
    statusEl.replaceChildren();
  }
}

function setCount(n) {
  countEl.textContent = n ? `${n} 条消息` : '';
}

/** 追加一条气泡，返回该行的容器 */
function appendBubble(role, text) {
  const row = el('div', `row ${role}`);
  row.appendChild(el('div', 'bubble', text));
  messagesEl.appendChild(row);
  scrollToBottom();
  return row;
}

/** 把工具轨迹渲染成可折叠区块 */
function appendTrace(container, trace) {
  if (!Array.isArray(trace) || trace.length === 0) return;

  const details = el('details', 'trace');
  details.appendChild(el('summary', null, `工具调用 ${trace.length} 次`));

  for (const item of trace) {
    const block = el('div', 'trace-item');
    const args = JSON.stringify(item.args ?? {});
    block.appendChild(el('div', 'trace-name', `${item.name}(${args})`));
    block.appendChild(el('div', 'trace-result', String(item.result ?? '')));
    details.appendChild(block);
  }

  container.appendChild(details);
  scrollToBottom();
}

function showEmptyState() {
  messagesEl.replaceChildren();
  const box = el('div', 'empty');
  box.appendChild(el('div', null, '可以试着问：'));
  box.appendChild(el('strong', null, '北京天气怎么样？'));
  box.appendChild(el('div', null, '张三的快递到哪了？'));
  box.appendChild(el('div', null, '帮我算一下 (12+8)*3/4'));
  messagesEl.appendChild(box);
}

/** 渲染一轮历史对话 */
function renderTurn(turn) {
  if (turn.question) appendBubble('user', turn.question);
  const row = appendBubble('agent', turn.answer || '（无回答）');
  appendTrace(row, turn.toolTrace);
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const turns = data.turns ?? [];
    if (turns.length === 0) {
      showEmptyState();
    } else {
      messagesEl.replaceChildren();
      turns.forEach(renderTurn);
      scrollToBottom();
    }
    setCount(data.count ?? 0);
  } catch (err) {
    showEmptyState();
    appendBubble('system', `加载历史失败：${err.message}`);
  }
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;

  inputEl.value = '';
  autoResize();
  appendBubble('user', text);
  setBusy(true);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const row = appendBubble('agent', data.answer || '（空回答）');
    appendTrace(row, data.toolTrace);
    setCount(data.count ?? 0);
  } catch (err) {
    appendBubble('system', `请求失败：${err.message}`);
  } finally {
    setBusy(false);
    inputEl.focus();
  }
}

async function clearHistory() {
  if (busy) return;
  if (!window.confirm('确定清空当前会话？此操作不可撤销。')) return;

  try {
    const res = await fetch('/api/clear', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showEmptyState();
    setCount(0);
  } catch (err) {
    appendBubble('system', `清空失败：${err.message}`);
  }
}

/** 输入框高度自适应 */
function autoResize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
}

inputEl.addEventListener('input', autoResize);

inputEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  // 中文输入法正在拼写时，Enter 是确认候选词，不能当作发送
  if (e.isComposing) return;
  e.preventDefault();
  send();
});

sendBtn.addEventListener('click', send);
clearBtn.addEventListener('click', clearHistory);

inputEl.focus();
loadHistory();
