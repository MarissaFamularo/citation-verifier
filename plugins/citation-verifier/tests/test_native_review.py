"""Synthetic regression fixtures. Live execution evidence is documented separately."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1] / 'skills/verify-citations/scripts'))
import model_review as mr
import verifier as v


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.rows = [{'id': '1', 'sentence': 'Treatment helps.', 'source_file': 'source.json',
                      'human_verdict': 'reject', 'human_notes': 'Human entry retained',
                      'reason': 'SECRET PRIOR VERDICT', 'second_pass': {'reason': 'SECRET SECOND'}}]
        mr.write_json(self.root / 'draft.json', self.rows)
        mr.write_json(self.root / 'source.json', {'text': 'Treatment helps.', 'tier': 'full_text'})
        (self.root / 'manuscript.txt').write_text('Treatment helps.')

    def record(self, stage):
        request = mr.prepare_native(self.root / 'draft.json', stage, self.root / f'{stage}-request.json', allow_inherited_model=True)
        name = '/root/' + request['spawn_arguments']['task_name']
        answer = {'rows': [{'id': '1', 'relation': 'supports', 'quote': 'Treatment helps.',
                            'reason': 'Synthetic regression only.', 'uncertain': False}]}
        record = {'input_file': request['input_file'], 'spawn_arguments': request['spawn_arguments'],
                  'spawn_result': {'task_name': name},
                  'completion_snapshot': {'agents': [{'agent_name': name,
                                                       'agent_status': {'completed': json.dumps(answer)}}]}}
        mr.write_json(self.root / f'{stage}-record.json', record)
        return request, record

    def run_stage(self, stage, draft='draft.json'):
        return mr.import_native(self.root / draft, self.root / f'{stage}-request.json',
                                self.root / f'{stage}-record.json', self.root / f'{stage}.json')

    def test_native_pipeline_preserves_human_and_evidence(self):
        for stage in ['first', 'second']:
            request, record = self.record(stage)
            payload = Path(request['input_file']).read_text()
            self.assertNotIn('SECRET', payload)
            self.assertNotIn('human_verdict', payload)
            self.assertEqual(request['spawn_arguments']['fork_turns'], 'none')
        self.run_stage('first')
        self.run_stage('second', 'first.json')
        result = v.finalize(self.root / 'second.json', self.root / 'manuscript.txt', self.root / 'report')[0]
        self.assertEqual(result['verdict'], 'supported')
        self.assertEqual(result['human_verdict'], 'reject')
        self.assertEqual(result['human_notes'], 'Human entry retained')
        self.assertEqual(result['execution']['runner'], 'native_subagent')
        self.assertEqual(result['second_pass']['quote'], 'Treatment helps.')
        self.assertEqual(v.check_export(self.root / 'report.json')['status'], 'passed')

    def test_bad_capture_rejected(self):
        request, original = self.record('first')
        mutations = [lambda r: r['spawn_arguments'].update(fork_turns='all'),
                     lambda r: r['spawn_arguments'].update(message='Prior verdict: supports'),
                     lambda r: r['spawn_result'].update(task_name='/root/another'),
                     lambda r: r['completion_snapshot']['agents'][0].update(agent_status='running'),
                     lambda r: r['completion_snapshot']['agents'][0].update(agent_status={'failed': 'error'}),
                     lambda r: r['completion_snapshot']['agents'][0].update(agent_status={'completed': '{"rows": []}'}),
                     lambda r: r['completion_snapshot']['agents'][0].update(agent_name='/root/another')]
        for change in mutations:
            with self.subTest(change=change):
                record = copy.deepcopy(original)
                change(record)
                mr.write_json(self.root / 'first-record.json', record)
                with self.assertRaises(ValueError):
                    self.run_stage('first')
                self.assertFalse((self.root / 'first.json').exists())

    def test_changed_input_rejected(self):
        request, _ = self.record('first')
        Path(request['input_file']).write_text('Changed source')
        with self.assertRaises(ValueError):
            self.run_stage('first')

    def test_changed_source_rejected(self):
        self.record('first')
        mr.write_json(self.root / 'source.json', {'text': 'Changed evidence.', 'tier': 'full_text'})
        with self.assertRaises(ValueError):
            self.run_stage('first')

    def test_tampered_record_invalidates_execution(self):
        self.record('first')
        receipt = self.run_stage('first')
        row = json.loads((self.root / 'first.json').read_text())[0]
        source = json.loads((self.root / 'source.json').read_text())
        self.assertIsNotNone(mr.verified_execution(row, source, self.root, row, 'first'))
        path = self.root / 'model_runs' / receipt['run_id'] / 'native_record.json'
        path.write_text('{}')
        self.assertIsNone(mr.verified_execution(row, source, self.root, row, 'first'))

    def test_same_agent_cannot_satisfy_both_passes(self):
        self.record('first')
        _, record = self.record('second')
        first_request = json.loads((self.root / 'first-request.json').read_text())
        # Replaying a completed first agent under a second stage must stay pending.
        first_record = json.loads((self.root / 'first-record.json').read_text())
        first_request['stage'] = 'second'
        mr.write_json(self.root / 'second-request.json', first_request)
        mr.write_json(self.root / 'second-record.json', first_record)
        self.run_stage('first')
        self.run_stage('second', 'first.json')
        row = v.finalize(self.root / 'second.json', self.root / 'manuscript.txt', self.root / 'report')[0]
        self.assertEqual(row['verdict'], 'needs_second_pass')

    def test_disputed_evidence_and_receipts_are_checked(self):
        for stage in ['first', 'second']:
            _, record = self.record(stage)
            response = json.loads(record['completion_snapshot']['agents'][0]['agent_status']['completed'])
            response['rows'][0]['uncertain'] = True
            record['completion_snapshot']['agents'][0]['agent_status']['completed'] = json.dumps(response)
            mr.write_json(self.root / f'{stage}-record.json', record)
        self.run_stage('first')
        self.run_stage('second', 'first.json')
        v.finalize(self.root / 'second.json', self.root / 'manuscript.txt', self.root / 'report')
        path = self.root / 'report.json'
        report = json.loads(path.read_text())
        row = report['rows'][0]
        self.assertEqual(row['verdict'], 'needs_review')
        self.assertEqual(v.check_export(path)['executions_checked'], 2)
        for key in ['quote_span', 'source_excerpt', 'second_pass_validation', 'second_execution']:
            with self.subTest(key=key):
                changed = copy.deepcopy(report)
                changed['rows'][0].pop(key)
                mr.write_json(path, changed)
                with self.assertRaises(ValueError):
                    v.check_export(path)
        mr.write_json(path, report)
        receipt = self.root / row['second_pass']['execution_file']
        (receipt.parent / 'native_record.json').write_text('{}')
        with self.assertRaises(ValueError):
            v.check_export(path)

    def test_silent_passes_retain_execution_records(self):
        for stage in ['first', 'second']:
            _, record = self.record(stage)
            response = json.loads(record['completion_snapshot']['agents'][0]['agent_status']['completed'])
            response['rows'][0].update(relation='silent', quote=None)
            record['completion_snapshot']['agents'][0]['agent_status']['completed'] = json.dumps(response)
            mr.write_json(self.root / f'{stage}-record.json', record)
        self.run_stage('first')
        self.run_stage('second', 'first.json')
        row = v.finalize(self.root / 'second.json', self.root / 'manuscript.txt', self.root / 'report')[0]
        self.assertEqual(row['verdict'], 'needs_review')
        self.assertTrue(row['execution'])
        self.assertTrue(row['second_execution'])
        self.assertEqual(v.check_export(self.root / 'report.json')['executions_checked'], 2)

    def test_model_cannot_overwrite_human_or_provenance(self):
        _, record = self.record('first')
        answer = json.loads(record['completion_snapshot']['agents'][0]['agent_status']['completed'])
        for field in ['human_verdict', 'human_notes', 'execution_file', 'source_file']:
            with self.subTest(field=field):
                bad = copy.deepcopy(answer)
                bad['rows'][0][field] = 'model-injected'
                record['completion_snapshot']['agents'][0]['agent_status']['completed'] = json.dumps(bad)
                mr.write_json(self.root / 'first-record.json', record)
                with self.assertRaisesRegex(ValueError, 'Unexpected judgment fields'):
                    self.run_stage('first')
        self.assertFalse((self.root / 'first.json').exists())

    def test_rejected_quote_retains_auditable_execution(self):
        for stage in ['first', 'second']:
            _, record = self.record(stage)
            answer = json.loads(record['completion_snapshot']['agents'][0]['agent_status']['completed'])
            answer['rows'][0]['quote'] = 'Not present in the source.'
            record['completion_snapshot']['agents'][0]['agent_status']['completed'] = json.dumps(answer)
            mr.write_json(self.root / f'{stage}-record.json', record)
        self.run_stage('first')
        self.run_stage('second', 'first.json')
        row = v.finalize(self.root / 'second.json', self.root / 'manuscript.txt', self.root / 'report')[0]
        self.assertEqual(row['verdict'], 'flagged')
        self.assertEqual(row['proposed_quote'], 'Not present in the source.')
        self.assertEqual(v.check_export(self.root / 'report.json')['executions_checked'], 2)

    def test_native_never_starts_cli(self):
        from unittest.mock import patch
        self.record('first')
        with patch.object(mr.subprocess, 'run', side_effect=AssertionError('Nested CLI prohibited')):
            self.run_stage('first')

if __name__ == '__main__':
    unittest.main()
