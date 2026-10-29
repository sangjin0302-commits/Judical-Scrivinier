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
  LOCK_MS: 120000
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

function PB1F_hash_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(value))).replace(/=+$/, '');
}

function PB1F_owner_() {
  var owner = String(Session.getTemporaryActiveUserKey() || '').trim();
  if (!owner) throw new Error('사용자 식별 불가');
  return owner;
}

function PB1F_propertyKey_(kind, value) {
  return 'PB1F_' + kind + '_' + PB1F_hash_(value).slice(0, 32);
}

function PB1F_parseProperty_(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (error) { throw new Error('PB1F 상태 속성 손상'); }
}

function PB1F_assertOwner_(record, owner) {
  if (!record || record.owner !== owner) throw new Error('다른 사용자의 세트 접근 차단');
}

function PB1F_answerDigest_(answers) {
  return PB1F_hash_(answers.join('|'));
}

function PB1F_assertBlankTarget_(sheet, row, count, width) {
  var values = sheet.getRange(row, 1, count, width).getDisplayValues();
  if (values.some(function (item) { return item.some(function (cell) { return String(cell).trim(); }); })) {
    throw new Error('다음 행 포인터가 기존 기록을 가리킴');
  }
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
  if (!requestId || requestId.length > 200) throw new Error('유효한 requestId 필요');
  var lock = LockService.getScriptLock();
  lock.waitLock(PB1F.LOCK_MS);
  try {
    var props = PropertiesService.getScriptProperties();
    var owner = PB1F_owner_();
    var issueKey = PB1F_propertyKey_('ISSUE', owner + ':' + requestId);
    var pendingKey = PB1F_propertyKey_('PENDING', owner + ':' + requestId);
    var completed = PB1F_parseProperty_(props.getProperty(issueKey));
    var ss = PB1F_ss_();
    if (completed) {
      PB1F_assertOwner_(completed, owner);
      return PB1F_reloadSet_(ss, completed, started, true);
    }
    var pending = PB1F_parseProperty_(props.getProperty(pendingKey));
    if (pending) {
      PB1F_assertOwner_(pending, owner);
      return PB1F_resumeIssue_(ss, props, issueKey, pendingKey, pending, started);
    }

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
    pending = { setId: setId, owner: owner, seed: baseSeed, picks: picks };
    var now = new Date();
    var rows = picks.map(function (pick, index) {
      return [setId, now, index + 1, pick.key, '아니오', '아니오', selected[index][8]];
    });
    var startRow = Number(bridge.getRange('B11').getValue());
    if (!Number.isInteger(startRow) || startRow < PB1F.FIRST_DATA_ROW) {
      throw new Error('세트관리 다음 행 불명');
    }
    pending.startRow = startRow;
    props.setProperty(pendingKey, JSON.stringify(pending));
    PB1F_ensureRows_(setSheet, startRow + rows.length - 1);
    PB1F_assertBlankTarget_(setSheet, startRow, rows.length, 7);
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
    var published = setSheet.getRange(startRow, 1, rows.length, 7).getValues();
    PB1F_validateSetRows_(published, pending, true, true);
    props.setProperty(issueKey, JSON.stringify(pending));
    props.setProperty(PB1F_propertyKey_('SET', setId), JSON.stringify(pending));
    props.deleteProperty(pendingKey);
    return PB1F_present_(setId, picks, selected, baseSeed, started, false);
  } finally {
    lock.releaseLock();
  }
}

function PB1F_validateSetRows_(rows, record, requirePublished, requireUnsubmitted) {
  if (rows.length !== record.picks.length) throw new Error('세트 행 수 검증 실패');
  rows.forEach(function (row, index) {
    if (String(row[0]) !== record.setId || Number(row[2]) !== index + 1 ||
        String(row[3]).trim() !== record.picks[index].key ||
        (requirePublished && String(row[4]).trim() !== '예') ||
        (requireUnsubmitted && String(row[5]).trim() !== '아니오')) {
      throw new Error('세트 상태 검증 실패');
    }
  });
}

function PB1F_findSetRows_(setSheet, setId) {
  if (setSheet.getLastRow() < PB1F.FIRST_DATA_ROW) return [];
  return setSheet.getRange(PB1F.FIRST_DATA_ROW, 1,
    setSheet.getLastRow() - PB1F.FIRST_DATA_ROW + 1, 7).getValues()
    .filter(function (row) { return String(row[0]) === setId; })
    .sort(function (a, b) { return Number(a[2]) - Number(b[2]); });
}

function PB1F_resumeIssue_(ss, props, issueKey, pendingKey, pending, started) {
  var setSheet = ss.getSheetByName(PB1F.SETS);
  var bridge = ss.getSheetByName(PB1F.BRIDGE);
  if (!setSheet || !bridge) throw new Error('필수 시트 없음');
  var rows = PB1F_findSetRows_(setSheet, pending.setId);
  var createdNow = false;
  if (!rows.length) {
    var selected = PB1F_selectedRows_(bridge, pending.picks);
    var startRow = Number(bridge.getRange('B11').getValue());
    if (!Number.isInteger(startRow) || startRow < PB1F.FIRST_DATA_ROW) throw new Error('세트관리 다음 행 불명');
    var now = new Date();
    PB1F_ensureRows_(setSheet, startRow + pending.picks.length - 1);
    PB1F_assertBlankTarget_(setSheet, startRow, pending.picks.length, 7);
    setSheet.getRange(startRow, 1, pending.picks.length, 7).setValues(
      pending.picks.map(function (pick, index) {
        return [pending.setId, now, index + 1, pick.key, '아니오', '아니오', selected[index][8]];
      }));
    SpreadsheetApp.flush();
    rows = PB1F_findSetRows_(setSheet, pending.setId);
    createdNow = true;
  }
  PB1F_validateSetRows_(rows, pending, !createdNow, true);
  var matches = setSheet.createTextFinder(pending.setId).matchEntireCell(true).findAll()
    .filter(function (range) { return range.getColumn() === 1; })
    .map(function (range) { return range.getRow(); }).sort(function (a, b) { return a - b; });
  if (matches.length !== pending.picks.length || matches.some(function (row, index) {
    return row !== matches[0] + index;
  })) throw new Error('보류 세트 위치 확인 실패');
  if (createdNow) {
    setSheet.getRange(matches[0], 5, pending.picks.length, 1).setValue('예');
    SpreadsheetApp.flush();
  }
  pending.startRow = matches[0];
  PB1F_validateSetRows_(PB1F_findSetRows_(setSheet, pending.setId), pending, true, true);
  props.setProperty(issueKey, JSON.stringify(pending));
  props.setProperty(PB1F_propertyKey_('SET', pending.setId), JSON.stringify(pending));
  props.deleteProperty(pendingKey);
  return PB1F_reloadSet_(ss, pending, started, true);
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

function PB1F_reloadSet_(ss, record, started, replayed) {
  var setSheet = ss.getSheetByName(PB1F.SETS);
  var bridge = ss.getSheetByName(PB1F.BRIDGE);
  var values = PB1F_findSetRows_(setSheet, record.setId);
  if (!values.length) throw new Error('재시도 세트 없음');
  PB1F_validateSetRows_(values, record, true, false);
  var picks = record.picks;
  var selected = PB1F_selectedRows_(bridge, picks);
  return PB1F_present_(record.setId, picks, selected, record.seed, started, replayed);
}

function PB1F_rowsForSet_(sheet, setId, width) {
  if (sheet.getLastRow() < PB1F.FIRST_DATA_ROW) return [];
  return sheet.getRange(PB1F.FIRST_DATA_ROW, 1,
    sheet.getLastRow() - PB1F.FIRST_DATA_ROW + 1, width).getValues()
    .filter(function (row) { return String(row[0]) === setId; });
}

function PB1F_findRecordedRows_(sheet, setId, idColumn, width) {
  if (sheet.getLastRow() < PB1F.FIRST_DATA_ROW) return [];
  return sheet.getRange(PB1F.FIRST_DATA_ROW, 1,
    sheet.getLastRow() - PB1F.FIRST_DATA_ROW + 1, width).getValues()
    .map(function (values, index) { return { values: values, row: PB1F.FIRST_DATA_ROW + index }; })
    .filter(function (item) { return String(item.values[idColumn]) === setId; });
}

function PB1F_indexedSetRows_(setSheet, setRecord) {
  var count = setRecord.picks.length;
  if (Number.isInteger(setRecord.startRow) && setRecord.startRow >= PB1F.FIRST_DATA_ROW) {
    return setSheet.getRange(setRecord.startRow, 1, count, 7).getValues()
      .map(function (row, index) { return { row: row, sheetRow: setRecord.startRow + index }; });
  }
  var all = setSheet.getRange(PB1F.FIRST_DATA_ROW, 1,
    Math.max(setSheet.getLastRow() - PB1F.FIRST_DATA_ROW + 1, 1), 7).getValues();
  var indexed = [];
  all.forEach(function (row, index) {
    if (String(row[0]) === setRecord.setId) {
      indexed.push({ row: row, sheetRow: PB1F.FIRST_DATA_ROW + index });
    }
  });
  return indexed.sort(function (a, b) { return Number(a.row[2]) - Number(b.row[2]); });
}

function PB1F_contiguousRows_(start, count) {
  var rows = [];
  for (var i = 0; i < count; i++) rows.push(start + i);
  return rows;
}

function PB1F_mergeRows_(existing, added) {
  var seen = {};
  return (existing || []).concat(added || []).filter(function (row) {
    var key = String(row);
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function PB1F_readRecordedRows_(sheet, rowNumbers, width) {
  if (!rowNumbers || !rowNumbers.length) return [];
  var sorted = rowNumbers.slice().sort(function (a, b) { return a - b; });
  var contiguous = sorted.every(function (row, index) { return row === sorted[0] + index; });
  if (contiguous) return sheet.getRange(sorted[0], 1, sorted.length, width).getValues();
  return sorted.map(function (row) { return sheet.getRange(row, 1, 1, width).getValues()[0]; });
}

function PB1F_ensureRows_(sheet, lastRow) {
  if (sheet.getMaxRows() < lastRow) sheet.insertRowsAfter(sheet.getMaxRows(), lastRow - sheet.getMaxRows());
}

function PB1F_grade(payload) {
  payload = payload || {};
  var started = Date.now();
  var timing = {};
  var stageStarted = started;
  function mark(name) {
    var now = Date.now();
    timing[name] = now - stageStarted;
    stageStarted = now;
  }
  var setId = String(payload.setId || '').trim();
  if (!setId || !Array.isArray(payload.answers)) throw new Error('setId/answers 필요');
  var answers = payload.answers.map(PB1F_normalizeAnswer_);
  var lock = LockService.getScriptLock();
  lock.waitLock(PB1F.LOCK_MS);
  mark('lockWait');
  try {
    var ss = PB1F_ss_();
    var props = PropertiesService.getScriptProperties();
    var owner = PB1F_owner_();
    var setRecord = PB1F_parseProperty_(props.getProperty(PB1F_propertyKey_('SET', setId)));
    PB1F_assertOwner_(setRecord, owner);
    var submissionKey = PB1F_propertyKey_('SUBMISSION', setId);
    var digest = PB1F_answerDigest_(answers);
    var reserved = PB1F_parseProperty_(props.getProperty(submissionKey));
    if (reserved && (reserved.owner !== owner || reserved.digest !== digest)) {
      throw new Error('서로 다른 답안 재제출 거부');
    }
    var setSheet = ss.getSheetByName(PB1F.SETS);
    var bridge = ss.getSheetByName(PB1F.BRIDGE);
    var ox = ss.getSheetByName(PB1F.ANSWERS);
    var history = ss.getSheetByName(PB1F.HISTORY);
    var judge = ss.getSheetByName(PB1F.JUDGE);
    if (!setSheet || !bridge || !ox || !history || !judge) throw new Error('필수 시트 없음');

    var indexed = PB1F_indexedSetRows_(setSheet, setRecord);
    if (!indexed.length || indexed.length !== answers.length) throw new Error('답안 수 불일치');
    PB1F_validateSetRows_(indexed.map(function (item) { return item.row; }), setRecord, true, false);
    var keys = indexed.map(function (item) { return String(item.row[3]); });
    if (new Set(keys).size !== keys.length) throw new Error('세트 안정키 중복');
    mark('setLookup');

    bridge.getRange('K17:K56').clearContent();
    bridge.getRange(17, 11, keys.length, 1).setValues(keys.map(function (key) { return [key]; }));
    SpreadsheetApp.flush();
    mark('judgeSelectionFlush');
    if (props.getProperty('PB1F_TEST_AUDIT') === '예') {
      props.setProperty('PB1F_TEST_AUDIT_JUDGE_COUNT', String(
        Number(props.getProperty('PB1F_TEST_AUDIT_JUDGE_COUNT') || 0) + 1));
    }
    var keyRows = judge.getRange(5, 1, PB1F.MAX_PICK, 7).getValues();
    var keyMap = {};
    keyRows.forEach(function (row) { if (row[0]) keyMap[String(row[0])] = row; });
    var graded = keys.map(function (key, index) {
      var row = keyMap[key];
      if (!row) throw new Error('선택 채점키 없음: ' + key);
      if (String(row[6]).trim() !== '확정') throw new Error('선택 채점키 상태 비정상: ' + key);
      var correct = PB1F_normalizeAnswer_(row[1]);
      return { key: key, no: index + 1, answer: answers[index], correct: correct,
        score: answers[index] === correct ? 1 : 0, source: row[4], sourceTime: row[5] || indexed[index].row[6] };
    });
    mark('judgeReadAndGrade');

    var newReservation = !reserved;
    if (newReservation) {
      reserved = { owner: owner, digest: digest, complete: false, oxRows: [], historyRows: [] };
      props.setProperty(submissionKey, JSON.stringify(reserved));
    }

    var oxExisting = [], historyExisting = [];
    if (newReservation) {
      // This call persisted the reservation before any record write.
    } else if (reserved.oxRows && reserved.oxRows.length &&
        reserved.historyRows && reserved.historyRows.length) {
      oxExisting = PB1F_readRecordedRows_(ox, reserved.oxRows, 7)
        .filter(function (row) { return String(row[0]) === setId; });
      historyExisting = PB1F_readRecordedRows_(history, reserved.historyRows, 12)
        .filter(function (row) { return String(row[1]) === setId; });
    } else {
      // Existing reservations without complete pointers always take the safe recovery scan.
      var oldOx = PB1F_findRecordedRows_(ox, setId, 0, 7);
      var oldHistory = PB1F_findRecordedRows_(history, setId, 1, 12);
      oxExisting = oldOx.map(function (item) { return item.values; });
      historyExisting = oldHistory.map(function (item) { return item.values; });
      reserved.oxRows = oldOx.map(function (item) { return item.row; });
      reserved.historyRows = oldHistory.map(function (item) { return item.row; });
    }
    var oxByKey = {}, historyByKey = {};
    oxExisting.forEach(function (row) { oxByKey[String(row[2])] = row; });
    historyExisting.forEach(function (row) { historyByKey[String(row[0])] = row; });
    mark('existingRecordLookup');
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

    var oxStart = null, historyStart = null;
    if (missingOx.length) {
      oxStart = Number(bridge.getRange('B12').getValue());
      if (!Number.isInteger(oxStart) || oxStart < PB1F.FIRST_DATA_ROW) throw new Error('OX 다음 행 불명');
      PB1F_ensureRows_(ox, oxStart + missingOx.length - 1);
      PB1F_assertBlankTarget_(ox, oxStart, missingOx.length, 7);
      reserved.oxRows = PB1F_mergeRows_(reserved.oxRows,
        PB1F_contiguousRows_(oxStart, missingOx.length));
    }
    if (missingHistory.length) {
      historyStart = Number(bridge.getRange('B13').getValue());
      if (!Number.isInteger(historyStart) || historyStart < PB1F.FIRST_DATA_ROW) throw new Error('풀이이력 다음 행 불명');
      PB1F_ensureRows_(history, historyStart + missingHistory.length - 1);
      PB1F_assertBlankTarget_(history, historyStart, missingHistory.length, 12);
      reserved.historyRows = PB1F_mergeRows_(reserved.historyRows,
        PB1F_contiguousRows_(historyStart, missingHistory.length));
    }
    // Persist exact target rows before either write. A crash therefore resumes by inspecting them.
    props.setProperty(submissionKey, JSON.stringify(reserved));
    if (missingOx.length) ox.getRange(oxStart, 1, missingOx.length, 7).setValues(missingOx);
    if (missingHistory.length) {
      history.getRange(historyStart, 1, missingHistory.length, 12).setValues(missingHistory);
    }
    mark('recordWrites');
    SpreadsheetApp.flush();
    mark('recordFlush');

    var finalOx = PB1F_readRecordedRows_(ox, reserved.oxRows, 8)
      .filter(function (row) { return String(row[0]) === setId; });
    var finalHistory = PB1F_readRecordedRows_(history, reserved.historyRows, 13)
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
    mark('finalRecordValidation');
    var submittedRows = indexed.map(function (item) { return item.sheetRow; });
    if (submittedRows.some(function (row, index) { return row !== submittedRows[0] + index; })) {
      throw new Error('세트 행 연속성 검증 실패');
    }
    setSheet.getRange(submittedRows[0], 6, submittedRows.length, 1).setValue('예');
    mark('submittedWrites');
    SpreadsheetApp.flush();
    mark('submittedFlush');
    reserved.complete = true;
    props.setProperty(submissionKey, JSON.stringify(reserved));
    return { ok: true, setId: setId, count: graded.length,
      score: graded.reduce(function (sum, item) { return sum + item.score; }, 0),
      replayed: !missingOx.length && !missingHistory.length,
      results: graded.map(function (item) { return { no: item.no, answer: item.answer,
        correct: item.correct, score: item.score }; }),
      timingMs: { total: Date.now() - started, stages: timing } };
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('PB1FastSafeUI')
    .setTitle('민법 1차 OX 10문제')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
