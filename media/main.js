(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  let state = { status: 'idle', files: [] };
  // Chosen option per question. Keys name the question's review, so answers
  // reset when that review is rewritten: "all:<tree>:<n>" or "file:<path>:<key>".
  const answers = {};
  // Text typed into "answer in your own words" boxes, kept across re-renders.
  const drafts = {};

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function button(label, className, onClick) {
    const node = el('button', className, label);
    node.addEventListener('click', onClick);
    return node;
  }

  function link(label, title, message) {
    const node = el('a', 'file-link', label);
    node.href = '#';
    node.title = title;
    node.addEventListener('click', (event) => {
      event.preventDefault();
      vscode.postMessage(message);
    });
    return node;
  }

  function fileLink(file, line) {
    const label = line ? `${file}:${line}` : file;
    return link(label, `Open ${label}`, { type: 'openFile', file, line });
  }

  function section(title) {
    const node = el('section');
    node.appendChild(el('h2', null, title));
    return node;
  }

  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }

  function renderRisk(risk, showFile) {
    const card = el('div', `risk ${risk.severity}`);
    const head = el('div', 'risk-head');
    head.appendChild(el('span', 'severity', risk.severity));
    head.appendChild(el('strong', null, risk.title));
    card.appendChild(head);
    if (risk.detail) {
      card.appendChild(el('p', null, risk.detail));
    }
    if (risk.file && (showFile || risk.line)) {
      card.appendChild(showFile ? fileLink(risk.file, risk.line) : link(`line ${risk.line}`, `Open ${risk.file}:${risk.line}`, { type: 'openFile', file: risk.file, line: risk.line }));
    }
    return card;
  }

  const VERDICTS = { correct: 'Correct.', partly: 'Partly right.', incorrect: 'Not quite.' };

  function typedAnswer(key) {
    return (state.typed || {})[key];
  }

  /** A question counts as answered once an option is picked or a typed answer has been marked. */
  function isAnswered(key) {
    const typed = typedAnswer(key);
    return answers[key] !== undefined || Boolean(typed && typed.state === 'ready');
  }

  function isRight(q, key) {
    const typed = typedAnswer(key);
    return answers[key] === q.answer || Boolean(typed && typed.state === 'ready' && typed.result.verdict === 'correct');
  }

  function renderOwnAnswer(key) {
    const row = el('form', 'own-answer');
    const input = el('input');
    input.type = 'text';
    input.maxLength = 1000;
    input.placeholder = 'Or answer in your own words';
    input.setAttribute('aria-label', 'Answer in your own words');
    input.dataset.key = key;
    input.value = drafts[key] || '';
    const check = el('button', 'secondary', 'Check');
    check.type = 'submit';
    check.disabled = !input.value.trim();
    input.addEventListener('input', () => {
      drafts[key] = input.value;
      check.disabled = !input.value.trim();
    });
    row.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value.trim()) {
        vscode.postMessage({ type: 'answer', key, text: input.value.trim() });
      }
    });
    row.append(input, check);
    return row;
  }

  function renderQuestion(q, key, label) {
    const block = el('div', 'question');
    block.appendChild(el('p', 'prompt', label + q.question));
    const chosen = answers[key];
    const typed = typedAnswer(key);
    const checking = Boolean(typed && typed.state === 'loading');
    const answered = isAnswered(key);
    q.options.forEach((option, optionIndex) => {
      const choice = button(option, 'option', () => {
        answers[key] = optionIndex;
        render();
      });
      choice.disabled = answered || checking;
      if (answered) {
        if (optionIndex === q.answer) {
          choice.classList.add('correct');
        } else if (optionIndex === chosen) {
          choice.classList.add('wrong');
        }
      }
      block.appendChild(choice);
    });

    if (typed) {
      block.appendChild(el('p', 'your-answer', `Your answer: ${typed.text}`));
    }
    if (checking) {
      const loading = el('div', 'loading inline');
      loading.append(el('span', 'spinner'), el('span', null, 'Checking your answer…'));
      block.appendChild(loading);
    } else if (typed && typed.state === 'error') {
      block.appendChild(el('p', 'error', typed.error || 'Your answer could not be checked.'));
    }
    if (!answered && !checking) {
      block.appendChild(renderOwnAnswer(key));
    }

    if (typed && typed.state === 'ready') {
      block.appendChild(el('p', `explanation verdict ${typed.result.verdict}`, `${VERDICTS[typed.result.verdict]} ${typed.result.feedback}`));
      block.appendChild(el('p', 'explanation', q.explanation));
    } else if (chosen !== undefined) {
      block.appendChild(el('p', 'explanation', (chosen === q.answer ? 'Correct. ' : 'Not quite. ') + q.explanation));
    }
    return block;
  }

  function renderHeader() {
    const header = el('div', 'header');
    const count = state.files.length;
    const busy = state.status === 'loading';
    header.appendChild(el('p', 'count', count === 0 ? 'Nothing new since your last review.' : `${plural(count, 'file', 'files')} changed since your last review.`));

    const actions = el('div', 'actions');
    const review = button(state.review ? 'Review all again' : 'Review all changes', 'primary', () => vscode.postMessage({ type: 'review' }));
    review.disabled = busy || count === 0;
    const done = button('Mark as reviewed', 'secondary', () => vscode.postMessage({ type: 'markReviewed' }));
    done.disabled = count === 0;
    actions.append(review, done);
    header.appendChild(actions);

    const live = el('label', 'live');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = Boolean(state.live);
    box.addEventListener('change', () => {
      vscode.postMessage({ type: 'setLive', on: box.checked });
      // The checkbox follows the real setting, which arrives with the next state.
      box.checked = Boolean(state.live);
    });
    live.append(box, el('span', null, 'Live review: review each file as soon as it stops changing'));
    header.appendChild(live);

    const provider = el('label', 'provider');
    const select = el('select');
    for (const [value, label] of [
      ['claude', 'Claude Code CLI'],
      ['copilot', 'GitHub Copilot'],
    ]) {
      const option = el('option', null, label);
      option.value = value;
      select.appendChild(option);
    }
    select.value = state.provider || 'claude';
    select.disabled = busy;
    select.addEventListener('change', () => vscode.postMessage({ type: 'setProvider', provider: select.value }));
    provider.append(el('span', null, 'Reviews written by'), select);
    header.appendChild(provider);
    return header;
  }

  function renderCard(file, card) {
    const body = el('div', 'card');
    if (card.state === 'waiting') {
      body.appendChild(el('p', 'muted', 'Waiting for this file to stop changing…'));
    } else if (card.state === 'loading') {
      const loading = el('div', 'loading inline');
      loading.append(el('span', 'spinner'), el('span', null, 'Reviewing…'));
      body.appendChild(loading);
    } else if (card.state === 'skipped') {
      body.appendChild(el('p', 'muted', 'Not sent for review: binary, generated, or a file that may hold secrets.'));
    } else if (card.state === 'error') {
      body.appendChild(el('p', 'error', card.error || 'This file could not be reviewed.'));
    } else if (card.review) {
      body.appendChild(el('p', null, card.review.what));
      for (const risk of card.review.risks) {
        body.appendChild(renderRisk(risk, false));
      }
      if (card.review.question) {
        body.appendChild(renderQuestion(card.review.question, `file:${file.path}:${card.key}`, ''));
      }
    }
    return body;
  }

  function renderFiles() {
    const cards = state.cards || {};
    const details = el('details', 'files');
    details.open = Boolean(state.live) || !state.review;
    const ready = state.files.filter((f) => cards[f.path] && cards[f.path].state === 'ready').length;
    details.appendChild(el('summary', null, state.live ? `Changed files (${ready} of ${state.files.length} reviewed)` : 'Changed files'));
    const list = el('ul');
    for (const file of state.files) {
      const item = el('li');
      const row = el('div', 'file-row');
      row.appendChild(el('span', `status ${file.status}`, file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'));
      row.appendChild(link(file.path, 'Show what changed in this file', { type: 'openDiff', file: file.path }));
      const card = cards[file.path];
      if (card && card.state === 'ready' && card.review) {
        const worst = card.review.risks[0];
        row.appendChild(el('span', `badge ${worst ? worst.severity : 'clear'}`, worst ? plural(card.review.risks.length, 'risk', 'risks') : 'ok'));
      }
      if (file.added !== null) {
        row.appendChild(el('span', 'counts', `+${file.added} −${file.deleted}`));
      }
      item.appendChild(row);
      if (card) {
        item.appendChild(renderCard(file, card));
      }
      list.appendChild(item);
    }
    details.appendChild(list);
    return details;
  }

  function renderReview() {
    const review = state.review;
    const wrap = el('div', 'review');

    if (state.stale) {
      wrap.appendChild(el('p', 'notice', 'Files have changed again since this review was written.'));
    }
    if (state.trimmedFiles) {
      wrap.appendChild(
        el('p', 'notice', `The changes were too large to review in full. ${state.trimmedFiles === 1 ? '1 file was' : `${state.trimmedFiles} files were`} left out or cut short.`),
      );
    }
    if (state.excludedFiles) {
      wrap.appendChild(
        el(
          'p',
          'notice',
          `${state.excludedFiles === 1 ? '1 changed file was' : `${state.excludedFiles} changed files were`} not sent for review: lock files, generated files and files that may hold secrets are held back.`,
        ),
      );
    }

    const summary = section('Summary of all changes');
    summary.appendChild(el('p', null, review.summary));
    wrap.appendChild(summary);

    if (review.changes.length > 0) {
      const changes = section('What changed');
      for (const change of review.changes) {
        const item = el('div', 'change');
        item.appendChild(fileLink(change.file));
        item.appendChild(el('p', null, change.what));
        changes.appendChild(item);
      }
      wrap.appendChild(changes);
    }

    const risks = section('Worth a second look');
    if (review.risks.length === 0) {
      risks.appendChild(el('p', 'muted', 'Nothing stood out as risky.'));
    }
    for (const risk of review.risks) {
      risks.appendChild(renderRisk(risk, true));
    }
    wrap.appendChild(risks);

    if (review.questions.length > 0) {
      const quiz = section('Check your understanding');
      const keys = review.questions.map((_, index) => `all:${state.reviewTree}:${index}`);
      review.questions.forEach((q, index) => quiz.appendChild(renderQuestion(q, keys[index], `${index + 1}. `)));
      if (keys.every(isAnswered)) {
        const right = review.questions.filter((q, index) => isRight(q, keys[index])).length;
        quiz.appendChild(el('p', 'score', `You got ${right} of ${review.questions.length}.`));
      }
      wrap.appendChild(quiz);
    }
    return wrap;
  }

  function render() {
    // Rebuilding the page would drop the caret from a box the user is typing in.
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : undefined;
    const caret = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : undefined;
    draw();
    if (focused) {
      const input = [...app.querySelectorAll('input[data-key]')].find((node) => node.dataset.key === focused);
      if (input) {
        input.focus();
        input.setSelectionRange(caret[0], caret[1]);
      }
    }
  }

  function draw() {
    app.replaceChildren();

    if (state.status === 'no-git') {
      app.appendChild(el('p', 'muted', 'Tailgate needs git, and could not run it. Install git, make sure it is on your PATH, then reload the window.'));
      return;
    }
    if (state.status === 'no-repo') {
      app.appendChild(el('p', 'muted', 'Open a folder that is a git repository to start reviewing changes.'));
      return;
    }

    app.appendChild(renderHeader());
    if (state.files.length > 0) {
      app.appendChild(renderFiles());
    }

    if (state.status === 'loading') {
      const loading = el('div', 'loading');
      loading.appendChild(el('span', 'spinner'));
      loading.appendChild(el('span', null, 'Reading all the changes…'));
      loading.appendChild(button('Cancel', 'secondary', () => vscode.postMessage({ type: 'cancel' })));
      app.appendChild(loading);
    } else if (state.status === 'error') {
      app.appendChild(el('p', 'error', state.error || 'Something went wrong.'));
    } else if (state.status === 'ready' && state.review) {
      app.appendChild(renderReview());
    }
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      // Re-rendering replaces the list, so keep the reader's place.
      const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
      state = event.data.state;
      render();
      if (document.scrollingElement) {
        document.scrollingElement.scrollTop = scroll;
      }
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
