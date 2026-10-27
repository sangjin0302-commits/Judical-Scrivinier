"""Synthetic PB1 v2 contract tests. No Google service, sheet, or key store access."""
import threading
import unittest
from pathlib import Path


class FakeStore:
    def __init__(self):
        self.lock = threading.Lock()
        self.sets = {}
        self.ox = {}
        self.history = {}

    def issue(self, request_id, displayed_by_scope):
        with self.lock:
            if request_id in self.sets:
                return self.sets[request_id]
            keys = [key for displayed in displayed_by_scope for key in displayed]
            if len(keys) != len(set(keys)) or len(keys) > 40:
                raise ValueError("invalid_candidates")
            self.sets[request_id] = tuple(keys)
            return tuple(keys)

    def grade(self, request_id, answers, key_map, fail_after_ox=False):
        with self.lock:
            keys = self.sets[request_id]
            if len(keys) != len(answers) or any(a not in ("O", "X") for a in answers):
                raise ValueError("invalid_submission")
            for key in keys:
                if key not in key_map:
                    raise ValueError("missing_selected_key")
            for index, key in enumerate(keys):
                expected = (key_map[key], answers[index] == key_map[key])
                old = self.ox.get((request_id, key))
                if old is not None and old != expected[0]:
                    raise ValueError("ox_conflict")
                self.ox[(request_id, key)] = expected[0]
            if fail_after_ox:
                raise RuntimeError("synthetic_partial_failure")
            for index, key in enumerate(keys):
                expected = (answers[index], answers[index] == key_map[key])
                old = self.history.get((request_id, key))
                if old is not None and old != expected:
                    raise ValueError("history_conflict")
                self.history[(request_id, key)] = expected
            return sum(self.history[(request_id, key)][1] for key in keys)


class PB1FastSafeTests(unittest.TestCase):
    def test_source_blocks_operational_original(self):
        source = (Path(__file__).parents[1] / "apps-script/pb1-fast-safe/PB1FastSafe.gs").read_text(encoding="utf-8")
        self.assertIn("if (id === PB1F.ORIGINAL_ID)", source)
        self.assertIn("운영 원본 실행 차단", source)

    def test_bridge_display_order_is_preserved_across_scopes(self):
        store = FakeStore()
        self.assertEqual(store.issue("r1", [["T3", "T1", "T2"], ["P7", "P4"]]),
                         ("T3", "T1", "T2", "P7", "P4"))

    def test_issue_retry_is_idempotent(self):
        store = FakeStore()
        first = store.issue("r1", [["K1", "K2"]])
        second = store.issue("r1", [["DIFFERENT"]])
        self.assertEqual(first, second)

    def test_cross_scope_duplicate_is_rejected(self):
        with self.assertRaises(ValueError):
            FakeStore().issue("r1", [["K1"], ["K1"]])

    def test_only_selected_keys_are_required(self):
        store = FakeStore()
        store.issue("r1", [["K1", "K2"]])
        self.assertEqual(store.grade("r1", ["O", "X"], {"K1": "O", "K2": "X"}), 2)
        with self.assertRaises(ValueError):
            store.grade("r1", ["O", "X"], {"K1": "O"})

    def test_partial_write_resumes_without_duplicates(self):
        store = FakeStore()
        store.issue("r1", [["K1", "K2"]])
        with self.assertRaises(RuntimeError):
            store.grade("r1", ["O", "X"], {"K1": "O", "K2": "O"}, fail_after_ox=True)
        self.assertEqual(store.grade("r1", ["O", "X"], {"K1": "O", "K2": "O"}), 1)
        self.assertEqual(len(store.ox), 2)
        self.assertEqual(len(store.history), 2)

    def test_duplicate_grade_same_payload_is_idempotent(self):
        store = FakeStore()
        store.issue("r1", [["K1", "K2"]])
        key_map = {"K1": "O", "K2": "X"}
        self.assertEqual(store.grade("r1", ["O", "X"], key_map), 2)
        self.assertEqual(store.grade("r1", ["O", "X"], key_map), 2)
        self.assertEqual(len(store.ox), len(store.history), 2)

    def test_conflicting_duplicate_grade_is_rejected(self):
        store = FakeStore()
        store.issue("r1", [["K1"]])
        store.grade("r1", ["O"], {"K1": "O"})
        with self.assertRaises(ValueError):
            store.grade("r1", ["X"], {"K1": "O"})

    def test_concurrent_duplicate_issue_creates_one_set(self):
        store = FakeStore()
        results = []
        threads = [threading.Thread(target=lambda: results.append(store.issue("same", [["K1"]])))
                   for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(set(results)), 1)
        self.assertEqual(len(store.sets), 1)


if __name__ == "__main__":
    unittest.main()
