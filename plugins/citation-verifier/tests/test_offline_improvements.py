"""Synthetic only: no network, model execution, manuscript or historical audit data."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parents[1] / 'skills/verify-citations/scripts'))
import model_review as mr
import verifier as v
from numeric_evidence import missing_numbers, tokens
import test_native_review as native_fixtures


class ImprovementTests(unittest.TestCase):
    setUp = native_fixtures.NativeTests.setUp
    record = native_fixtures.NativeTests.record
    run_stage = native_fixtures.NativeTests.run_stage

    def test_spaced_signs_and_ranges(self):
        cases = [
            ('− 0.42', '−0.42', True), ('- 0.42', '-0.42', True),
            ('−\u202f0.42', '-0.42', True), ('-\t0.42', '− 0.42', True),
            ('− 0.42', '0.42', False), ('0.42', '− 0.42', False),
            ('− 0.42', '−0.43', False), ('− 28%', '-28 percent', True),
            ('− 28%', '28%', False), ('− 28%', '-28 persons', False),
            ('− 42 mg/d', '-42 mg/day', True), ('- 42 mg/d', '42 mg/d', False),
            ('− 42 mg/d', '-42 g/day', False),
            ('< − 42 mg/d', '-43 mg/d', True), ('< − 42 mg/d', '-41 mg/d', False),
            ('− 0.62 to − 0.42', '-0.62 to -0.42', True),
            ('− 0.62 to − 0.42', '-0.62 to 0.42', False),
            ('0.42 - 0.62', '0.42 to 0.62', True),
            ('0.42 − 0.62', '0.42 to -0.62', True),
            ('0.42 − 0.62', '0.42 to 0.62', False),
            ('0.42–0.62', '0.42 to 0.62', True),
            ('nearly − 100,000 people', '-98,261 participants', False),
            ('about 28%', '27.9%', False), ('+ 0.42', '0.42', True),
        ]
        for claim, source, expected in cases:
            with self.subTest(claim=claim, source=source):
                self.assertEqual(not missing_numbers(claim, source), expected)
        self.assertEqual([str(t['value']) for t in tokens('-0.62 - - 0.42')], ['-0.62', '-0.42'])

    def repeated(self, count=12):
        source = {'text': ('Synthetic complete source paragraph. ' * 1000) + 'END OF EVIDENCE',
                  'tier': 'full_text', 'identifier': 'source-A'}
        mr.write_json(self.root / 'source.json', source)
        rows = [dict(self.rows[0], id=str(i), reference='Reference A') for i in range(count)]
        # Same exact text, but distinct identity metadata must stay per pair.
        mr.write_json(self.root / 'alias.json', dict(source, identifier='source-B', tier='partial_text'))
        rows[-1]['source_file'] = 'alias.json'
        mr.write_json(self.root / 'draft.json', rows)
        return rows

    def test_payload_reduction_complete_source_and_binding(self):
        rows = self.repeated()
        compact = mr.payload_for(rows, self.root)
        legacy = mr.expanded_payload(compact)
        self.assertEqual(len(compact['sources']), 1)
        self.assertTrue(next(iter(compact['sources'].values())).endswith('END OF EVIDENCE'))
        self.assertEqual(legacy[-1]['source_identifier'], 'source-B')
        self.assertEqual(legacy[-1]['source_tier'], 'partial_text')
        before, after = len(mr.prompt_for(legacy).encode()), len(mr.prompt_for(compact).encode())
        self.assertLess(after, before / 5)
        self.assertNotIn('SECRET', mr.prompt_for(compact))
        self.assertEqual(mr.payload_from_prompt(mr.prompt_for(legacy)), legacy)
        self.assertEqual(mr.payload_from_prompt(mr.prompt_for(compact)), legacy)
        changed = copy.deepcopy(compact)
        key = next(iter(changed['sources']))
        changed['sources'][key] += 'CHANGED'
        with self.assertRaises(ValueError):
            mr.expanded_payload(changed)
        changed = copy.deepcopy(compact)
        changed['pairs'][0]['source_id'] = 'missing'
        with self.assertRaises(ValueError):
            mr.expanded_payload(changed)

    def test_rebinding_to_other_valid_source_invalidates_execution(self):
        self.record('first')
        receipt = self.run_stage('first')
        row = json.loads((self.root / 'first.json').read_text())[0]
        source = json.loads((self.root / 'source.json').read_text())
        self.assertIsNotNone(mr.verified_execution(row, source, self.root, row, 'first'))
        self.assertIsNone(mr.verified_execution(row, dict(source, text='Different source.'), self.root, row, 'first'))

    def test_preflight_and_explicit_resume_scope(self):
        rows = self.repeated(5)
        rows.append({'id': 'missing', 'sentence': 'Unresolved.', 'reference': 'Reference C'})
        mr.write_json(self.root / 'draft.json', rows)
        plan = mr.preflight(self.root / 'draft.json', batch_size=2)
        self.assertEqual((plan['pairs'], plan['unique_source_texts'], plan['unique_source_files']), (6, 1, 2))
        self.assertEqual(plan['unavailable_pair_ids'], ['missing'])
        self.assertEqual(plan['planned_review_batches'], 6)
        self.assertEqual(plan['planned_judgments'], 10)
        self.assertFalse(plan['model_selection']['backend_verified'])
        request = mr.prepare_native(self.root / 'draft.json', 'second', self.root / 'subset.json', ['1'], allow_inherited_model=True)
        self.assertEqual([p['id'] for p in mr.payload_from_prompt(Path(request['input_file']).read_text())], ['1'])
        too_big = mr.preflight(self.root / 'draft.json', max_chars=200)
        self.assertEqual(len(too_big['oversized']), 10)
        self.assertEqual(too_big['planned_review_batches'], 0)
        self.assertEqual(plan['scope_sha256'], mr.preflight(self.root / 'draft.json')['scope_sha256'])

    def test_saved_reviews_and_existing_outputs_are_not_overwritten(self):
        self.record('first')
        self.run_stage('first')
        original = (self.root / 'first.json').read_bytes()
        with self.assertRaises(ValueError):
            self.run_stage('first')
        with self.assertRaises(ValueError):
            mr.prepare_native(self.root / 'first.json', 'first', self.root / 'new.json')
        self.assertEqual((self.root / 'first.json').read_bytes(), original)
        plan = mr.preflight(self.root / 'first.json')
        self.assertEqual(plan['stages']['first']['completed'], ['1'])
        self.assertEqual(plan['stages']['second']['pending'], ['1'])

    def test_subset_import_preserves_other_saved_judgments(self):
        self.record('first')
        self.run_stage('first')
        saved = json.loads((self.root / 'first.json').read_text())[0]
        pending = dict(self.rows[0], id='2')
        mr.write_json(self.root / 'mixed.json', [saved, pending])
        request = mr.prepare_native(self.root / 'mixed.json', 'first', self.root / 'batch.json', ['2'], allow_inherited_model=True)
        name = '/root/' + request['spawn_arguments']['task_name']
        answer = {'rows': [{'id': '2', 'relation': 'supports', 'quote': 'Treatment helps.',
                           'reason': 'Synthetic only.', 'uncertain': False}]}
        record = {'input_file': request['input_file'], 'spawn_arguments': request['spawn_arguments'],
                  'spawn_result': {'task_name': name}, 'completion_snapshot': {'agents': [
                      {'agent_name': name, 'agent_status': {'completed': json.dumps(answer)}}]}}
        mr.write_json(self.root / 'batch-record.json', record)
        mr.import_native(self.root / 'mixed.json', self.root / 'batch.json', self.root / 'batch-record.json', self.root / 'resumed.json')
        resumed = json.loads((self.root / 'resumed.json').read_text())
        self.assertEqual(resumed[0], saved)
        self.assertEqual(resumed[1]['human_notes'], pending['human_notes'])
        self.assertIn('execution_file', resumed[1])

    def test_legacy_native_request_and_receipt_still_validate(self):
        request, record = self.record('first')
        prompt = mr.prompt_for(mr.expanded_payload(mr.payload_for(self.rows, self.root)))
        Path(request['input_file']).write_text(prompt)
        request['version'] = 1
        request.pop('pair_ids')
        request.pop('model_selection')
        request['spawn_arguments']['message'] = mr.native_message(request['input_file'], prompt)
        record['spawn_arguments'] = request['spawn_arguments']
        mr.write_json(self.root / 'first-request.json', request)
        mr.write_json(self.root / 'first-record.json', record)
        self.run_stage('first')
        row = json.loads((self.root / 'first.json').read_text())[0]
        self.assertIsNotNone(mr.verified_execution(row, json.loads((self.root / 'source.json').read_text()), self.root, row, 'first'))

    def test_explicit_host_model_selection_no_live_call(self):
        profile = {'version': 1, 'tool': 'collaboration.spawn_agent', 'model_argument': True,
                   'fork_turns_none': True, 'models': ['gpt-6-luna', 'gpt-6.1-sol'],
                   'lower_cost_default': 'gpt-6-luna', 'observation': 'Synthetic tool schema fixture, not a live probe.'}
        path = self.root / 'capabilities.json'
        mr.write_json(path, profile)
        with self.assertRaisesRegex(ValueError, 'Model/cost unknown'):
            mr.prepare_native(self.root / 'draft.json', 'first', self.root / 'not-prepared.json')
        self.assertFalse((self.root / 'not-prepared.json').exists())
        self.assertEqual(mr.selection_for(path)['model_requested'], 'gpt-6-luna')
        with self.assertRaises(ValueError):
            mr.selection_for(path, 'unlisted-model')
        with self.assertRaises(ValueError):
            mr.selection_for(model='gpt-6-luna')
        request = mr.prepare_native(self.root / 'draft.json', 'first', self.root / 'selected.json', capabilities=path)
        self.assertEqual(request['spawn_arguments']['model'], 'gpt-6-luna')
        _, record = self.record('second')
        record['input_file'] = request['input_file']
        record['spawn_arguments'] = request['spawn_arguments']
        name = '/root/' + request['spawn_arguments']['task_name']
        record['spawn_result']['task_name'] = name
        record['completion_snapshot']['agents'][0]['agent_name'] = name
        mr.write_json(self.root / 'selected-record.json', record)
        receipt = mr.import_native(self.root / 'draft.json', self.root / 'selected.json', self.root / 'selected-record.json', self.root / 'selected-result.json')
        self.assertEqual(receipt['model_requested'], 'gpt-6-luna')
        self.assertFalse(receipt['model_selection']['backend_verified'])
        row = json.loads((self.root / 'selected-result.json').read_text())[0]
        self.assertIsNotNone(mr.verified_execution(row, json.loads((self.root / 'source.json').read_text()), self.root, row, 'first'))

    def test_review_categories_are_additive_and_actionable(self):
        original = {'verdict': 'needs_review', 'relation': 'supports', 'uncertain': True,
                    'source_file': 'source.json', 'second_pass': {'relation': 'contradicts', 'uncertain': False},
                    'missing_numbers': ['- 0.42'], 'human_verdict': 'reject', 'human_notes': 'Keep'}
        row = copy.deepcopy(original)
        presentation = v.review_presentation(row)
        self.assertEqual(row, original)
        self.assertEqual(set(presentation['review_categories']), {'attribution_qualification_uncertainty',
            'reviewer_disagreement', 'likely_claim_source_contradiction', 'numeric_quote_software_validation_flag'})
        self.assertEqual(len(presentation['review_actions']), 4)
        self.assertEqual(presentation['clause_mapping_status'], 'not_recorded')
        self.assertIn('evidence_unavailable', v.review_presentation({'verdict': 'unresolved'})['review_categories'])

if __name__ == '__main__':
    unittest.main()
