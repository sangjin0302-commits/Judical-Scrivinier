/**
 * P2 Fast/Safe - official case issue, post-submission rubric release, and record commit.
 * Uses the same test-only spreadsheet gate as PB1 Fast/Safe.
 */
var P2F = Object.freeze({
  BRIDGE: 'GPT브리지_2차', SETS: '세트관리', JUDGE: 'GPT채점키_2차',
  HISTORY: '풀이이력', GRADES: '서술형채점', FIRST_DATA_ROW: 5,
  CANDIDATE_ROWS: 120, SELECT_ROWS: 20, EXPANDED_ROWS: 120, LOCK_MS: 120000
});

function P2F_key_(kind, value) {
  return 'P2F_' + kind + '_' + PB1F_hash_(value).slice(0, 32);
}

function P2F_json_(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (error) { throw new Error('P2 상태 속성 손상'); }
}

function P2F_text_(value, label, max) {
  var text = String(value || '').trim();
  if (!text || text.length > max) throw new Error(label + '가 유효하지 않습니다.');
  return text;
}

function P2F_setId_(ss) {
  return 'P2-' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone() || 'Asia/Seoul',
    'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 6);
}

function P2F_assertSheets_(ss) {
  var result = {};
  [P2F.BRIDGE, P2F.SETS, P2F.JUDGE, P2F.HISTORY, P2F.GRADES].forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) throw new Error('필수 시트 없음: ' + name);
    result[name] = sheet;
  });
  return result;
}

function P2F_select_(bridge, groupKeys) {
  bridge.getRange('K17:K36').clearContent();
  if (groupKeys.length) bridge.getRange(17, 11, groupKeys.length, 1)
    .setValues(groupKeys.map(function (key) { return [key]; }));
  SpreadsheetApp.flush();
  PB1F_bridgeStatus_(bridge);
  var rows = bridge.getRange(17, 22, P2F.EXPANDED_ROWS, 10).getValues()
    .filter(function (row) { return String(row[0]).trim(); });
  if (!rows.length) throw new Error('선택 사례의 소문항이 없습니다.');
  var allowed = {};
  groupKeys.forEach(function (key) { allowed[key] = true; });
  rows.forEach(function (row) {
    if (!allowed[String(row[1]).trim()]) throw new Error('선택하지 않은 사례가 확장됨');
  });
  return rows;
}

function P2F_present_(record, rows, started, replayed) {
  var groups = {};
  rows.forEach(function (row) {
    var groupKey = String(row[1]).trim();
    if (!groups[groupKey]) groups[groupKey] = {
      groupKey: groupKey, title: String(row[2]), commonFacts: String(row[3]), questions: []
    };
    groups[groupKey].questions.push({
      no: Number(row[9]) || groups[groupKey].questions.length + 1,
      key: String(row[0]), prompt: String(row[4]), pointsLabel: String(row[5]),
      sourceTime: row[8]
    });
  });
  return { ok: true, setId: record.setId, replayed: replayed,
    cases: record.groupKeys.map(function (key) { return groups[key]; }),
    questionCount: rows.length, timingMs: { total: Date.now() - started } };
}

function P2F_issue(payload) {
  payload = payload || {};
  var started = Date.now();
  var requestId = P2F_text_(payload.requestId, 'requestId', 200);
  var caseCount = Number(payload.caseCount || 1);
  if (!Number.isInteger(caseCount) || caseCount < 1 || caseCount > P2F.SELECT_ROWS) {
    throw new Error('사례 수는 1~20의 정수여야 합니다.');
  }
  var mode = String(payload.mode || '전범위').trim();
  if (['전범위', '범위지정', '취약'].indexOf(mode) < 0) throw new Error('출제 모드가 유효하지 않습니다.');
  var keyword = String(payload.keyword || '').trim();
  if (mode === '범위지정' && !keyword) throw new Error('범위지정에는 keyword가 필요합니다.');
  var lock = LockService.getScriptLock();
  lock.waitLock(P2F.LOCK_MS);
  try {
    var owner = PB1F_owner_();
    var props = PropertiesService.getScriptProperties();
    var requestKey = P2F_key_('ISSUE', owner + ':' + requestId);
    var old = P2F_json_(props.getProperty(requestKey));
    var ss = PB1F_ss_();
    var sheets = P2F_assertSheets_(ss);
    if (old) {
      PB1F_assertOwner_(old, owner);
      return P2F_present_(old, P2F_select_(sheets[P2F.BRIDGE], old.groupKeys), started, true);
    }
    var bridge = sheets[P2F.BRIDGE];
    PB1F_bridgeStatus_(bridge);
    var seed = PB1F_freshSeed_(bridge.getRange('B10').getValue());
    bridge.getRange('B7:B10').setValues([[mode], [keyword], [caseCount], [seed]]);
    bridge.getRange('K17:K36').clearContent();
    SpreadsheetApp.flush();
    PB1F_bridgeStatus_(bridge);
    var candidates = bridge.getRange(17, 1, P2F.CANDIDATE_ROWS, 10).getValues()
      .filter(function (row) { return String(row[0]).trim(); });
    if (candidates.length < caseCount) throw new Error('2차 사례 후보 부족');
    var groupKeys = candidates.slice(0, caseCount).map(function (row) { return String(row[0]).trim(); });
    var expanded = P2F_select_(bridge, groupKeys);
    var setId = P2F_setId_(ss);
    var record = { owner: owner, requestId: requestId, setId: setId, groupKeys: groupKeys,
      keys: expanded.map(function (row) { return String(row[0]); }), seed: seed };
    var startRow = Number(bridge.getRange('B11').getValue());
    if (!Number.isInteger(startRow) || startRow < P2F.FIRST_DATA_ROW) throw new Error('세트관리 다음 행 불명');
    PB1F_ensureRows_(sheets[P2F.SETS], startRow + expanded.length - 1);
    PB1F_assertBlankTarget_(sheets[P2F.SETS], startRow, expanded.length, 7);
    var now = new Date();
    sheets[P2F.SETS].getRange(startRow, 1, expanded.length, 7).setValues(expanded.map(function (row, i) {
      return [setId, now, i + 1, String(row[0]), '아니오', '아니오', row[8]];
    }));
    SpreadsheetApp.flush();
    sheets[P2F.SETS].getRange(startRow, 5, expanded.length, 1).setValue('예');
    SpreadsheetApp.flush();
    record.startRow = startRow;
    var check = sheets[P2F.SETS].getRange(startRow, 1, expanded.length, 7).getValues();
    check.forEach(function (row, i) {
      if (String(row[0]) !== setId || String(row[3]) !== record.keys[i] ||
          String(row[4]) !== '예' || String(row[5]) !== '아니오') throw new Error('2차 세트 등록 검증 실패');
    });
    props.setProperty(requestKey, JSON.stringify(record));
    props.setProperty(P2F_key_('SET', setId), JSON.stringify(record));
    return P2F_present_(record, expanded, started, false);
  } finally { lock.releaseLock(); }
}

function P2F_answers_(payload, record) {
  if (!Array.isArray(payload.answers) || payload.answers.length !== record.keys.length) {
    throw new Error('모든 소문항의 실제 원답이 필요합니다.');
  }
  var map = {};
  payload.answers.forEach(function (item) {
    var key = P2F_text_(item && item.key, '문제 안정키', 300);
    var text = P2F_text_(item && item.text, '사용자 원답', 50000);
    if (map[key]) throw new Error('중복 원답: ' + key);
    map[key] = text;
  });
  if (record.keys.some(function (key) { return !map[key]; }) || Object.keys(map).length !== record.keys.length) {
    throw new Error('세트와 원답의 안정키가 일치하지 않습니다.');
  }
  return record.keys.map(function (key) { return { key: key, text: map[key] }; });
}

function P2F_storeAnswers_(props, setId, answers) {
  var chunks = [];
  answers.forEach(function (item, answerIndex) {
    var textChunks = String(item.text).match(/[\s\S]{1,6000}/g) || [''];
    chunks.push(textChunks.length);
    textChunks.forEach(function (text, chunkIndex) {
      props.setProperty(P2F_key_('ANSWER', setId + ':' + answerIndex + ':' + chunkIndex), text);
    });
  });
  return chunks;
}

function P2F_loadAnswers_(props, setId, keys, chunkCounts) {
  return keys.map(function (key, answerIndex) {
    var text = '';
    for (var chunkIndex = 0; chunkIndex < chunkCounts[answerIndex]; chunkIndex++) {
      var chunk = props.getProperty(P2F_key_('ANSWER', setId + ':' + answerIndex + ':' + chunkIndex));
      if (chunk === null) throw new Error('보류 원답 조각 누락');
      text += chunk;
    }
    return { key: key, text: text };
  });
}

function P2F_deleteAnswers_(props, setId, chunkCounts) {
  chunkCounts.forEach(function (count, answerIndex) {
    for (var chunkIndex = 0; chunkIndex < count; chunkIndex++) {
      props.deleteProperty(P2F_key_('ANSWER', setId + ':' + answerIndex + ':' + chunkIndex));
    }
  });
}

function P2F_prepareGrade(payload) {
  payload = payload || {};
  var started = Date.now();
  var setId = P2F_text_(payload.setId, 'setId', 100);
  var lock = LockService.getScriptLock();
  lock.waitLock(P2F.LOCK_MS);
  try {
    var owner = PB1F_owner_();
    var props = PropertiesService.getScriptProperties();
    var record = P2F_json_(props.getProperty(P2F_key_('SET', setId)));
    PB1F_assertOwner_(record, owner);
    var answers = P2F_answers_(payload, record);
    var digest = PB1F_hash_(answers.map(function (item) { return item.key + ':' + item.text; }).join('|'));
    var submissionKey = P2F_key_('SUBMISSION', setId);
    var submission = P2F_json_(props.getProperty(submissionKey));
    var replayed = !!submission;
    if (submission && (submission.owner !== owner || submission.digest !== digest)) {
      throw new Error('서로 다른 2차 답안 재제출 거부');
    }
    if (!submission) {
      submission = { owner: owner, setId: setId, digest: digest,
        answerChunks: P2F_storeAnswers_(props, setId, answers), complete: false };
      props.setProperty(submissionKey, JSON.stringify(submission));
    }
    var ss = PB1F_ss_();
    var sheets = P2F_assertSheets_(ss);
    P2F_select_(sheets[P2F.BRIDGE], record.groupKeys);
    if (props.getProperty('P2F_TEST_AUDIT') === '예') props.setProperty('P2F_TEST_AUDIT_JUDGE_AFTER_SUBMIT', '예');
    var judgeRows = sheets[P2F.JUDGE].getRange(4, 1, P2F.SELECT_ROWS, 9).getValues();
    var judge = {};
    judgeRows.forEach(function (row) { if (row[0]) judge[String(row[0])] = row; });
    var rubrics = record.keys.map(function (key) {
      var row = judge[key];
      if (!row || String(row[8]).trim() !== '확정') throw new Error('확정된 2차 채점키 없음: ' + key);
      return { key: key, title: String(row[2]), coreConclusion: String(row[3]),
        authorities: String(row[4]), modelAnswer: String(row[5]), source: String(row[6]), sourceTime: row[7] };
    });
    return { ok: true, setId: setId, answersAccepted: true, replayed: replayed,
      evaluationNotice: '공식 시험 점수가 아니라 기존 채점기준에 따른 AI 학습평가입니다.',
      dimensions: ['쟁점', '목차', '법리', '판례', '포섭', '결론', '표현'], rubrics: rubrics,
      timingMs: { total: Date.now() - started } };
  } finally { lock.releaseLock(); }
}

function P2F_allowed_(settings, a1) {
  return settings.getRange(a1).getDisplayValues().map(function (row) { return String(row[0]).trim(); })
    .filter(function (value) { return value; });
}

function P2F_requireAllowed_(value, allowed, label) {
  value = String(value || '').trim();
  if (!value || allowed.indexOf(value) < 0) throw new Error(label + ' 허용값 위반: ' + value);
  return value;
}

function P2F_evaluations_(payload, record, allowed) {
  if (!Array.isArray(payload.evaluations) || payload.evaluations.length !== record.keys.length) {
    throw new Error('모든 소문항의 평가가 필요합니다.');
  }
  var map = {};
  payload.evaluations.forEach(function (item) {
    var key = P2F_text_(item && item.key, '평가 안정키', 300);
    if (map[key]) throw new Error('중복 평가: ' + key);
    var scores = item.scores || {};
    var seven = ['issue', 'outline', 'law', 'precedent', 'application', 'conclusion', 'expression']
      .map(function (name) {
        var score = Number(scores[name]);
        if ([0, 1, 2].indexOf(score) < 0) throw new Error('7요소 점수는 0/1/2만 허용');
        return score;
      });
    var maxPoints = Number(item.maxPoints);
    var awarded = Number(item.awardedPoints);
    if (!Number.isFinite(maxPoints) || maxPoints <= 0 || !Number.isFinite(awarded) || awarded < 0 || awarded > maxPoints) {
      throw new Error('득점/배점이 유효하지 않습니다.');
    }
    map[key] = { key: key, seven: seven, maxPoints: maxPoints, awardedPoints: awarded,
      correction: String(item.correction || ''),
      errorType: P2F_requireAllowed_(item.errorType, allowed.errorTypes, '오답 유형'),
      checkType: P2F_requireAllowed_(item.checkType, allowed.checkTypes, '민법형 체크유형'),
      missingOutline: String(item.missingOutline || ''), wrongLaw: String(item.wrongLaw || ''),
      applicationFix: String(item.applicationFix || ''), modelDifference: String(item.modelDifference || ''),
      nextReview: P2F_requireAllowed_(item.nextReview, allowed.reviewTypes, '다음 복습 형식') };
  });
  if (record.keys.some(function (key) { return !map[key]; })) throw new Error('평가 안정키 불일치');
  return record.keys.map(function (key) { return map[key]; });
}

function P2F_isBlank_(value) {
  return value === '' || value === null || typeof value === 'undefined';
}

function P2F_sameValue_(actual, expected) {
  if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime();
  if (actual instanceof Date && typeof expected === 'number') return actual.getTime() === expected;
  if (expected instanceof Date && actual instanceof Date) return actual.getTime() === expected.getTime();
  if (expected instanceof Date && typeof actual === 'number') return expected.getTime() === actual;
  if (typeof actual === 'number' || typeof expected === 'number') return Number(actual) === Number(expected);
  return String(actual) === String(expected);
}

function P2F_planRow_(sheetRow, actual, expected, writableIndexes, label) {
  writableIndexes.forEach(function (index) {
    if (!P2F_isBlank_(actual[index]) && !P2F_sameValue_(actual[index], expected[index])) {
      throw new Error(label + ' 기존 값 충돌: ' + sheetRow + '행 ' + (index + 1) + '열');
    }
  });
  var runs = [];
  var start = null;
  writableIndexes.forEach(function (index, position) {
    var missing = P2F_isBlank_(actual[index]);
    if (missing && start === null) start = index;
    var next = writableIndexes[position + 1];
    if (start !== null && (!missing || next !== index + 1)) {
      var end = missing ? index + 1 : index;
      runs.push({ row: sheetRow, start: start, values: expected.slice(start, end) });
      start = null;
    }
  });
  return runs;
}

function P2F_applyRuns_(sheet, runs) {
  runs.forEach(function (run) {
    sheet.getRange(run.row, run.start + 1, 1, run.values.length).setValues([run.values]);
  });
}

function P2F_testFail_(props, stage) {
  if (props.getProperty('P2F_TEST_MODE') === '예' && props.getProperty('P2F_TEST_FAIL_AT') === stage) {
    props.deleteProperty('P2F_TEST_FAIL_AT');
    throw new Error('P2F 주입 실패: ' + stage);
  }
}

function P2F_testControl(payload) {
  payload = payload || {};
  PB1F_ss_();
  var props = PropertiesService.getScriptProperties();
  if (payload.enabled === true) props.setProperty('P2F_TEST_MODE', '예');
  else props.deleteProperty('P2F_TEST_MODE');
  if (payload.failAt) props.setProperty('P2F_TEST_FAIL_AT', String(payload.failAt));
  else props.deleteProperty('P2F_TEST_FAIL_AT');
  return { ok: true, enabled: props.getProperty('P2F_TEST_MODE') === '예',
    failAt: props.getProperty('P2F_TEST_FAIL_AT') || '' };
}

function P2F_testInspectRecovery(payload) {
  payload = payload || {};
  PB1F_ss_();
  var setId = P2F_text_(payload.setId, 'setId', 100);
  var props = PropertiesService.getScriptProperties();
  var owner = PB1F_owner_();
  var record = P2F_json_(props.getProperty(P2F_key_('SET', setId)));
  var submission = P2F_json_(props.getProperty(P2F_key_('SUBMISSION', setId)));
  PB1F_assertOwner_(record, owner);
  PB1F_assertOwner_(submission, owner);
  var answersAvailable = false;
  try {
    answersAvailable = P2F_loadAnswers_(props, setId, record.keys, submission.answerChunks || []).length === record.keys.length;
  } catch (error) { answersAvailable = false; }
  return { ok: true, setId: setId, questionCount: record.keys.length,
    submission: { complete: submission.complete === true, hasGradeDigest: !!submission.gradeDigest,
      gradeDigest: submission.gradeDigest || '', historyStart: submission.historyStart || null,
      gradeStart: submission.gradeStart || null, submittedAt: submission.submittedAt || null,
      answersAvailable: answersAvailable, answerChunkCounts: submission.answerChunks || [] } };
}

function P2F_commitGrade(payload) {
  payload = payload || {};
  var started = Date.now();
  var setId = P2F_text_(payload.setId, 'setId', 100);
  var lock = LockService.getScriptLock();
  lock.waitLock(P2F.LOCK_MS);
  try {
    var owner = PB1F_owner_();
    var props = PropertiesService.getScriptProperties();
    var record = P2F_json_(props.getProperty(P2F_key_('SET', setId)));
    var submissionKey = P2F_key_('SUBMISSION', setId);
    var submission = P2F_json_(props.getProperty(submissionKey));
    PB1F_assertOwner_(record, owner);
    PB1F_assertOwner_(submission, owner);
    var ss = PB1F_ss_();
    var sheets = P2F_assertSheets_(ss);
    var settings = ss.getSheetByName('설정');
    if (!settings) throw new Error('필수 시트 없음: 설정');
    var allowed = { reviewTypes: P2F_allowed_(settings, 'P5:P9'),
      errorTypes: P2F_allowed_(settings, 'Q5:Q17'), checkTypes: P2F_allowed_(settings, 'R5:R18') };
    var evaluations = P2F_evaluations_(payload, record, allowed);
    var digest = PB1F_hash_(JSON.stringify(evaluations));
    if (submission.gradeDigest && submission.gradeDigest !== digest) throw new Error('서로 다른 평가 재확정 거부');
    if (submission.complete) return { ok: true, setId: setId, replayed: true,
      results: evaluations, timingMs: { total: Date.now() - started } };
    if (!submission.historyStart || !submission.gradeStart) {
      submission.historyStart = Number(sheets[P2F.BRIDGE].getRange('B12').getValue());
      submission.gradeStart = Number(sheets[P2F.BRIDGE].getRange('B13').getValue());
      submission.gradeDigest = digest;
      props.setProperty(submissionKey, JSON.stringify(submission));
    }
    P2F_testFail_(props, 'afterReservation');
    var count = record.keys.length;
    if (!Number.isInteger(submission.historyStart) || !Number.isInteger(submission.gradeStart)) throw new Error('기록 다음 행 불명');
    PB1F_ensureRows_(sheets[P2F.HISTORY], submission.historyStart + count - 1);
    PB1F_ensureRows_(sheets[P2F.GRADES], submission.gradeStart + count - 1);
    var historyExisting = sheets[P2F.HISTORY].getRange(submission.historyStart, 1, count, 12).getValues();
    var gradeExisting = sheets[P2F.GRADES].getRange(submission.gradeStart, 1, count, 26).getValues();
    if (!submission.submittedAt) {
      var existingDates = historyExisting.map(function (row) { return row[2]; })
        .filter(function (value) { return !P2F_isBlank_(value); })
        .map(function (value) { return value instanceof Date ? value.getTime() : Number(value); });
      if (existingDates.some(function (value) { return !Number.isFinite(value) || value !== existingDates[0]; })) {
        throw new Error('부분 기록의 실제 풀이일 충돌');
      }
      submission.submittedAt = existingDates.length ? existingDates[0] : Date.now();
      props.setProperty(submissionKey, JSON.stringify(submission));
    }
    var now = new Date(submission.submittedAt);
    var answerMap = {};
    P2F_loadAnswers_(props, setId, record.keys, submission.answerChunks || [])
      .forEach(function (item) { answerMap[item.key] = item.text; });
    var setRows = sheets[P2F.SETS].getRange(record.startRow, 1, count, 7).getValues();
    var historyExpected = evaluations.map(function (ev, i) {
      return [ev.key, setId, now, answerMap[ev.key], '채점완료', ev.awardedPoints, ev.maxPoints,
        '아니오', setRows[i][6], ev.errorType, ev.checkType, ''];
    });
    var answerIds = evaluations.map(function (ev, i) {
      return gradeExisting[i][0] || ('ANS-' + Utilities.getUuid());
    });
    var gradeExpected = evaluations.map(function (ev, i) {
      return [answerIds[i], setId, ev.key, now, ev.maxPoints, ev.awardedPoints, '',
        ev.seven[0], ev.seven[1], ev.seven[2], ev.seven[3], ev.seven[4], ev.seven[5], ev.seven[6],
        '', '', '', ev.errorType, ev.missingOutline, ev.wrongLaw, ev.applicationFix,
        ev.modelDifference, ev.nextReview, '', '', ''];
    });
    var historyIndexes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    var gradeIndexes = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 17, 18, 19, 20, 21, 22];
    var historyRuns = [], gradeRuns = [];
    historyExisting.forEach(function (row, i) {
      historyRuns = historyRuns.concat(P2F_planRow_(submission.historyStart + i, row,
        historyExpected[i], historyIndexes, '풀이이력'));
    });
    gradeExisting.forEach(function (row, i) {
      gradeRuns = gradeRuns.concat(P2F_planRow_(submission.gradeStart + i, row,
        gradeExpected[i], gradeIndexes, '서술형채점'));
    });
    P2F_applyRuns_(sheets[P2F.HISTORY], historyRuns);
    P2F_testFail_(props, 'afterHistory');
    P2F_applyRuns_(sheets[P2F.GRADES], gradeRuns);
    P2F_testFail_(props, 'afterGrades');
    SpreadsheetApp.flush();
    var hCheck = sheets[P2F.HISTORY].getRange(submission.historyStart, 1, count, 12).getValues();
    var gCheck = sheets[P2F.GRADES].getRange(submission.gradeStart, 1, count, 24).getValues();
    hCheck.forEach(function (row, i) {
      if (String(row[0]) !== evaluations[i].key || String(row[1]) !== setId || String(row[3]) !== answerMap[evaluations[i].key]) {
        throw new Error('2차 원답 기록 검증 실패');
      }
    });
    gCheck.forEach(function (row, i) {
      if (String(row[1]) !== setId || String(row[2]) !== evaluations[i].key || Number(row[5]) !== evaluations[i].awardedPoints ||
          row.slice(7, 14).some(function (value, j) { return Number(value) !== evaluations[i].seven[j]; }) ||
          String(row[17]) !== evaluations[i].errorType || String(row[22]) !== evaluations[i].nextReview) {
        throw new Error('2차 평가 기록 검증 실패');
      }
    });
    P2F_testFail_(props, 'beforeSubmitted');
    sheets[P2F.SETS].getRange(record.startRow, 6, count, 1).setValue('예');
    SpreadsheetApp.flush();
    var submitted = sheets[P2F.SETS].getRange(record.startRow, 6, count, 1).getDisplayValues();
    if (submitted.some(function (row) { return row[0] !== '예'; })) throw new Error('2차 제출 완료 검증 실패');
    submission.complete = true;
    props.setProperty(submissionKey, JSON.stringify(submission));
    P2F_deleteAnswers_(props, setId, submission.answerChunks || []);
    return { ok: true, setId: setId, replayed: false,
      notice: '공식 시험 결과가 아닌 기존 채점기준 기반 AI 학습평가', results: evaluations,
      timingMs: { total: Date.now() - started } };
  } finally { lock.releaseLock(); }
}
