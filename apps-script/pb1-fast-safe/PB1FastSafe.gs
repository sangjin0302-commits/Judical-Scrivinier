/**
 * PB1 Fast/Safe v2 — test-copy only source.
 *
 * Script property required: PB1F_TEST_SPREADSHEET_ID
 * The operational original is deliberately blocked in this revision.
 */
var PB1F = Object.freeze({
  ORIGINAL_ID: '13WfuSV2GvAXinISeHpuAKVpihEgj4DO4B65jIPpKD8s',
  BRIDGE: 'GPT브리지_1차',
  SETTINGS: '1차통합설정',
  SETS: '세트관리',
  JUDGE: 'GPT채점키_1차',
  ANSWERS: 'OX정답키',
  HISTORY: '풀이이력',
  FIRST_DATA_ROW: 5,
  MAX_PICK: 40,
  CANDIDATE_ROWS: 120,
  LOCK_MS: 30000
});

function PB1F_ss_() {
  var id = String(PropertiesService.getScriptProperties()
    .getProperty('PB1F_TEST_SPREADSHEET_ID') || '').trim();
  if (!id) throw new Error('PB1F_TEST_SPREADSHEET_ID가 없습니다.');
  if (id === PB1F.ORIGINAL_ID) throw new Error('운영 원본 실행 차단');
  return SpreadsheetApp.openById(id);
}

function PB1F_normalizeAnswer_(value) {
  var answer = String(value || '').trim().toUpperCase();
  if (answer !== 'O' && answer !== 'X') throw new Error('답안은 O/X만 허용');
  return answer;
}

function PB1F_freshSeed_(previous) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + ':' + Date.now()
  );
  var seed = Math.abs(((bytes[0] & 255) << 24) | ((bytes[1] & 255) << 16) |
    ((bytes[2] & 255) << 8) | (bytes[3] & 255));
  seed = seed || 1;
  if (seed === Number(previous)) seed = (seed % 2147483646) + 1;
  return seed;
}

function PB1F_setId_(ss, setSheet) {
  var zone = ss.getSpreadsheetTimeZone() || 'Asia/Seoul';
  var existing = {};
  if (setSheet.getLastRow() >= PB1F.FIRST_DATA_ROW) {
    setSheet.getRange(PB1F.FIRST_DATA_ROW, 1,
      setSheet.getLastRow() - PB1F.FIRST_DATA_ROW + 1, 1).getDisplayValues()
      .forEach(function (row) { if (row[0]) existing[row[0]] = true; });
  }
  for (var i = 0; i < 3; i++) {
    var id = 'P1-' + Utilities.formatDate(new Date(), zone, 'yyyyMMdd-HHmmss');
    if (!existing[id]) return id;
    Utilities.sleep(1000);
  }
  throw new Error('세트ID 중복');
}

function PB1F_activeScopes_(sheet) {
  if (sheet.getLastRow() < 4) throw new Error('통합 설정 없음');
  var rows = sheet.getRange(4, 1, sheet.getLastRow() - 3, 4).getValues();
  var scopes = rows.filter(function (row) {
    return String(row[3]).trim() === '예' && Number(row[2]) > 0 && String(row[1]).trim();
  }).map(function (row) {
    var count = Number(row[2]);
    if (!Number.isInteger(count) || count < 1) throw new Error('문항수는 양의 정수');
    return { area: String(row[0]), scope: String(row[1]), count: count };
  });
  var total = scopes.reduce(function (sum, item) { return sum + item.count; }, 0);
  if (!scopes.length) throw new Error('활성 범위 없음');
  if (total > PB1F.MAX_PICK) throw new Error('최대 40문항 초과');
  return scopes;
}

function PB1F_bridgeStatus_(bridge) {
  var status = String(bridge.getRange('B5').getDisplayValue()).trim();
  if (status !== '정상') throw new Error('브리지 상태 비정상: ' + status);
}

function PB1F_pickDisplayedTop_(bridge, scope, seed, seen) {
  bridge.getRange('B7:B10').setValues([
    ['범위지정'], [scope.scope], [scope.count], [seed]
  ]);
  bridge.getRange('K17:K56').clearContent();
  SpreadsheetApp.flush();
  PB1F_bridgeStatus_(bridge);
  var candidates = bridge.getRange(17, 1, PB1F.CANDIDATE_ROWS, 8).getValues()
    .filter(function (row) { return String(row[0]).trim(); });
  if (candidates.length < scope.count) throw new Error(scope.area + ' 후보 부족');
  return candidates.slice(0, scope.count).map(function (row) {
    var key = String(row[0]).trim();
    if (seen[key]) throw new Error('영역 간 안정키 중복: ' + key);
    seen[key] = true;
    return { area: scope.area, key: key };
  });
}

function PB1F_selectedRows_(bridge, picks) {
  bridge.getRange('K17:K56').clearContent();
  bridge.getRange(17, 11, picks.length, 1)
    .setValues(picks.map(function (pick) { return [pick.key]; }));
  SpreadsheetApp.flush();
  var rows = bridge.getRange(17, 11, picks.length, 9).getValues();
  rows.forEach(function (row, index) {
    if (String(row[0]).trim() !== picks[index].key || !String(row[2]).trim()) {
      throw new Error('선택 결과 검증 실패: ' + picks[index].key);
    }
  });
  return rows;
}

function PB1F_issue(payload) {
  payload = payload || {};
  var started = Date.now();
  var requestId = String(payload.requestId || '').trim();
  if (!requestId) throw new Error('requestId 필요');
  var lock = LockService.getScriptLock();
  lock.waitLock(PB1F.LOCK_MS);
  try {
    var props = PropertiesService.getScriptProperties();
    var retrySetId = props.getProperty('PB1F_ISSUE_' + requestId);
    var ss = PB1F_ss_();
    if (retrySetId) return PB1F_reloadSet_(ss, retrySetId, started, true);

    var bridge = ss.getSheetByName(PB1F.BRIDGE);
    var settings = ss.getSheetByName(PB1F.SETTINGS);
    var setSheet = ss.getSheetByName(PB1F.SETS);
    if (!bridge || !settings || !setSheet) throw new Error('필수 시트 없음');
    PB1F_bridgeStatus_(bridge);

    var scopes = PB1F_activeScopes_(settings);
    var previousSeed = bridge.getRange('B10').getValue();
    var baseSeed = PB1F_freshSeed_(previousSeed);
    var seen = {};
    var picks = [];
    scopes.forEach(function (scope, index) {
      picks = picks.concat(PB1F_pickDisplayedTop_(bridge, scope,
        ((baseSeed + index * 104729) % 2147483646) + 1, seen));
    });
    var selected = PB1F_selectedRows_(bridge, picks);
    var setId = PB1F_setId_(ss, setSheet);
    var now = new Date();
    var rows = picks.map(function (pick, index) {
      return [setId, now, index + 1, pick.key, '아니오', '아니오', selected[index][8]];
    });
    var startRow = Number(bridge.getRange('B11').getValue());
    if (!Number.isInteger(startRow) || startRow < PB1F.FIRST_DATA_ROW) {
      throw new Error('세트관리 다음 행 불명');
    }
    setSheet.getRange(startRow, 1, rows.length, 7).setValues(rows);
    SpreadsheetApp.flush();
    var check = setSheet.getRange(startRow, 1, rows.length, 7).getValues();
    check.forEach(function (row, index) {
      if (String(row[0]) !== setId || String(row[3]) !== picks[index].key || String(row[5]) !== '아니오') {
        throw new Error('세트 등록 검증 실패');
      }
    });
    setSheet.getRange(startRow, 5, rows.length, 1).setValue('예');
    SpreadsheetApp.flush();
    props.setProperty('PB1F_ISSUE_' + requestId, setId);
    return PB1F_present_(setId, picks, selected, baseSeed, started, false);
  } finally {
    lock.releaseLock();
  }
}

function PB1F_present_(setId, picks, selected, seed, started, replayed) {
  return {
    ok: true,
    setId: setId,
    count: picks.length,
    seed: seed,
    replayed: replayed,
    questions: selected.map(function (row, index) {
      return { no: index + 1, area: picks[index].area, key: picks[index].key,
        name: row[1], question: row[2], category: row[3], sourceTime: row[8] };
    }),
    timingMs: { total: Date.now() - started }
  };
}

function PB1F_reloadSet_(ss, setId, started, replayed) {
  var setSheet = ss.getSheetByName(PB1F.SETS);
  var bridge = ss.getSheetByName(PB1F.BRIDGE);
  var values = setSheet.getRange(PB1F.FIRST_DATA_ROW, 1,
    Math.max(setSheet.getLastRow() - PB1F.FIRST_DATA_ROW + 1, 1), 7).getValues()
    .filter(function (row) { return String(row[0]) === setId; })
    .sort(function (a, b) { return Number(a[2]) - Number(b[2]); });
  if (!values.length) throw new Error('재시도 세트 없음');
  var picks = values.map(function (row) { return { area: '', key: String(row[3]) }; });
  var selected = PB1F_selectedRows_(bridge, picks);
  return PB1F_present_(setId, picks, selected, '', started, replayed);
}

function PB1F_rowsForSet_(sheet, setId, width) {
  if (sheet.getLastRow() < PB1F.FIRST_DATA_ROW) return [];
  return sheet.getRange(PB1F.FIRST_DATA_ROW, 1,
    sheet.getLastRow() - PB1F.FIRST_DATA_ROW + 1, width).getValues()
    .filter(function (row) { return String(row[0]) === setId; });
}

function PB1F_ensureRows_(sheet, lastRow) {
  if (sheet.getMaxRows() < lastRow) sheet.insertRowsAfter(sheet.getMaxRows(), lastRow - sheet.getMaxRows());
}

function PB1F_grade(payload) {
  payload = payload || {};
  var started = Date.now();
  var setId = String(payload.setId || '').trim();
  if (!setId || !Array.isArray(payload.answers)) throw new Error('setId/answers 필요');
  var answers = payload.answers.map(PB1F_normalizeAnswer_);
  var lock = LockService.getScriptLock();
  lock.waitLock(PB1F.LOCK_MS);
  try {
    var ss = PB1F_ss_();
    var setSheet = ss.getSheetByName(PB1F.SETS);
    var bridge = ss.getSheetByName(PB1F.BRIDGE);
    var ox = ss.getSheetByName(PB1F.ANSWERS);
    var history = ss.getSheetByName(PB1F.HISTORY);
    var judge = ss.getSheetByName(PB1F.JUDGE);
    if (!setSheet || !bridge || !ox || !history || !judge) throw new Error('필수 시트 없음');

    var allSetRows = setSheet.getRange(PB1F.FIRST_DATA_ROW, 1,
      Math.max(setSheet.getLastRow() - PB1F.FIRST_DATA_ROW + 1, 1), 7).getValues();
    var indexed = [];
    allSetRows.forEach(function (row, index) {
      if (String(row[0]) === setId) indexed.push({ row: row, sheetRow: PB1F.FIRST_DATA_ROW + index });
    });
    indexed.sort(function (a, b) { return Number(a.row[2]) - Number(b.row[2]); });
    if (!indexed.length || indexed.length !== answers.length) throw new Error('답안 수 불일치');
    var keys = indexed.map(function (item) { return String(item.row[3]); });
    if (new Set(keys).size !== keys.length) throw new Error('세트 안정키 중복');

    bridge.getRange('K17:K56').clearContent();
    bridge.getRange(17, 11, keys.length, 1).setValues(keys.map(function (key) { return [key]; }));
    SpreadsheetApp.flush();
    var keyRows = judge.getRange(5, 1, PB1F.MAX_PICK, 7).getValues();
    var keyMap = {};
    keyRows.forEach(function (row) { if (row[0]) keyMap[String(row[0])] = row; });
    var graded = keys.map(function (key, index) {
      var row = keyMap[key];
      if (!row) throw new Error('선택 채점키 없음: ' + key);
      var correct = PB1F_normalizeAnswer_(row[1]);
      return { key: key, no: index + 1, answer: answers[index], correct: correct,
        score: answers[index] === correct ? 1 : 0, source: row[4], sourceTime: row[5] || indexed[index].row[6] };
    });

    var oxExisting = PB1F_rowsForSet_(ox, setId, 7);
    var historyExisting = history.getLastRow() < PB1F.FIRST_DATA_ROW ? [] :
      history.getRange(PB1F.FIRST_DATA_ROW, 1,
        history.getLastRow() - PB1F.FIRST_DATA_ROW + 1, 12).getValues()
        .filter(function (row) { return String(row[1]) === setId; });
    var oxByKey = {}, historyByKey = {};
    oxExisting.forEach(function (row) { oxByKey[String(row[2])] = row; });
    historyExisting.forEach(function (row) { historyByKey[String(row[0])] = row; });
    var missingOx = [], missingHistory = [], now = new Date();
    graded.forEach(function (item) {
      var oldOx = oxByKey[item.key];
      if (oldOx) {
        if (String(oldOx[3]) !== item.correct) throw new Error('기존 OX정답키 충돌: ' + item.key);
      } else {
        missingOx.push([setId, item.no, item.key, item.correct, item.source, '확정', item.sourceTime]);
      }
      var oldHistory = historyByKey[item.key];
      if (oldHistory) {
        if (String(oldHistory[3]) !== item.answer || Number(oldHistory[5]) !== item.score) {
          throw new Error('기존 풀이이력 충돌: ' + item.key);
        }
      } else {
        missingHistory.push([item.key, setId, now, item.answer, '채점완료', item.score, 1,
          item.score ? '아니오' : '예', '', '', '', '']);
      }
    });

    if (missingOx.length) {
      var oxStart = Number(bridge.getRange('B12').getValue());
      if (!Number.isInteger(oxStart) || oxStart < PB1F.FIRST_DATA_ROW) throw new Error('OX 다음 행 불명');
      PB1F_ensureRows_(ox, oxStart + missingOx.length - 1);
      ox.getRange(oxStart, 1, missingOx.length, 7).setValues(missingOx);
    }
    if (missingHistory.length) {
      var historyStart = Number(bridge.getRange('B13').getValue());
      if (!Number.isInteger(historyStart) || historyStart < PB1F.FIRST_DATA_ROW) throw new Error('풀이이력 다음 행 불명');
      PB1F_ensureRows_(history, historyStart + missingHistory.length - 1);
      history.getRange(historyStart, 1, missingHistory.length, 12).setValues(missingHistory);
    }
    SpreadsheetApp.flush();

    var finalOx = PB1F_rowsForSet_(ox, setId, 8);
    var finalHistory = history.getRange(PB1F.FIRST_DATA_ROW, 1,
      Math.max(history.getLastRow() - PB1F.FIRST_DATA_ROW + 1, 1), 13).getValues()
      .filter(function (row) { return String(row[1]) === setId; });
    if (finalOx.length !== keys.length || finalHistory.length !== keys.length) {
      throw new Error('최종 기록 수 검증 실패');
    }
    var oxFinalMap = {}, historyFinalMap = {};
    finalOx.forEach(function (row) { oxFinalMap[String(row[2])] = row; });
    finalHistory.forEach(function (row) { historyFinalMap[String(row[0])] = row; });
    graded.forEach(function (item) {
      var a = oxFinalMap[item.key], h = historyFinalMap[item.key];
      if (!a || !h || String(a[3]) !== item.correct || !String(a[7]).trim() ||
          String(h[3]) !== item.answer || Number(h[5]) !== item.score || !String(h[12]).trim()) {
        throw new Error('최종 기록 내용/수식 검증 실패: ' + item.key);
      }
    });
    indexed.forEach(function (item) { setSheet.getRange(item.sheetRow, 6).setValue('예'); });
    SpreadsheetApp.flush();
    return { ok: true, setId: setId, count: graded.length,
      score: graded.reduce(function (sum, item) { return sum + item.score; }, 0),
      replayed: !missingOx.length && !missingHistory.length,
      results: graded.map(function (item) { return { no: item.no, answer: item.answer,
        correct: item.correct, score: item.score }; }),
      timingMs: { total: Date.now() - started } };
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('PB1FastSafe')
    .setTitle('민법 1차 OX 10문제')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
