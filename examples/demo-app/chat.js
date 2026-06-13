// <demo-chat> — a self-contained web component that lives in an OPEN shadow root.
// It exercises the tricky bits the recorder must handle: typing into a shadow-DOM
// <textarea> (needs the native value setter), consuming an SSE stream incrementally,
// and rendering a final structured block (a table).
class DemoChat extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { display: block; }
        .card {
          background: #1a1c26; border: 1px solid #ffffff14; border-radius: 16px;
          padding: 18px; box-shadow: 0 20px 50px #0006;
        }
        .stream {
          min-height: 56px; white-space: pre-wrap; color: #d7dae8;
          font-size: 15px; line-height: 1.6;
        }
        .stream:empty::before { content: "El asistente responderá aquí…"; color: #5b6075; }
        .row { display: flex; gap: 10px; margin-top: 14px; }
        textarea {
          flex: 1; resize: none; height: 46px; padding: 12px 14px; border-radius: 10px;
          border: 1px solid #ffffff1f; background: #0f1118; color: #e8e9f0;
          font: inherit; outline: none;
        }
        textarea:focus { border-color: #6c5ce7; }
        button.send {
          padding: 0 18px; border: 0; border-radius: 10px; cursor: pointer;
          background: linear-gradient(135deg, #6c5ce7, #00cec9); color: #fff; font-weight: 600;
        }
        button.send:disabled { opacity: .5; cursor: default; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px; }
        th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #ffffff12; }
        th { color: #9aa0b4; font-weight: 600; }
        td.num { text-align: right; font-variant-numeric: tabular-nums; }
        .cursor { display: inline-block; width: 8px; height: 1em; background: #6c5ce7;
          vertical-align: -2px; animation: blink 1s steps(2) infinite; }
        @keyframes blink { 50% { opacity: 0; } }
      </style>
      <div class="card">
        <div class="stream" id="stream"></div>
        <div id="result"></div>
        <div class="row">
          <textarea placeholder="Ej: ventas por región" aria-label="Pregunta"></textarea>
          <button class="send" type="button">Enviar</button>
        </div>
      </div>`;
    this.$stream = root.getElementById('stream');
    this.$result = root.getElementById('result');
    this.$textarea = root.querySelector('textarea');
    this.$send = root.querySelector('button.send');
    this.$send.addEventListener('click', () => this.ask());
  }

  async ask() {
    const q = this.$textarea.value.trim();
    if (!q) return;
    this.$send.disabled = true;
    this.$result.innerHTML = '';
    this.$stream.innerHTML = '<span class="cursor"></span>';
    let text = '';

    const res = await fetch('/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const frame of frames) {
        const ev = /event:\s*(.*)/.exec(frame)?.[1]?.trim();
        const data = /data:\s*([\s\S]*)/.exec(frame)?.[1]?.trim();
        if (!ev) continue;
        const payload = data ? JSON.parse(data) : {};
        if (ev === 'text') {
          text += payload.delta || '';
          this.$stream.innerHTML = text + '<span class="cursor"></span>';
        } else if (ev === 'block' && payload.type === 'table') {
          this.renderTable(payload.data);
        } else if (ev === 'done') {
          this.$stream.innerHTML = text; // drop the streaming cursor
        }
      }
    }
    this.$send.disabled = false;
  }

  renderTable({ columns, rows }) {
    const thead = `<tr>${columns.map((c, i) => `<th${i ? ' class="num"' : ''}>${c}</th>`).join('')}</tr>`;
    const tbody = rows
      .map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`)
      .join('');
    this.$result.innerHTML = `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  }
}
customElements.define('demo-chat', DemoChat);
