"""Isolated catalog/config regressions. Never access the user's CLI home."""
import importlib.util
import json
import os
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native', os.path.join(os.path.dirname(__file__), 'native-cli.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class CatalogTests(unittest.TestCase):
    def test_claude_sets_per_model_compact_window(self):
        with tempfile.TemporaryDirectory() as home:
            settings = os.path.join(home, '.claude/settings.json')
            original = {'model': 'auto/claude-opus-5-5', 'env': {'ANTHROPIC_BASE_URL': 'http://127.0.0.1:3425'}}
            native.atomic_write(settings, json.dumps(original).encode())
            result = native.dispatch({'action': 'apply', 'tool': 'claude', 'port': 3425,
                'model': 'auto/claude-opus-5-5', 'contextWindow': 400000, 'bypass': True}, home)
            config = json.loads(native.read_bytes(settings))
            self.assertEqual(config['modelSettings']['auto/claude-opus-5-5']['autoCompactWindow'], 400000)
            self.assertEqual(config['permissions']['defaultMode'], 'bypassPermissions')
            self.assertEqual(config['model'], 'auto/claude-opus-5-5')
            self.assertNotIn('autoCompactWindow', config)
            self.assertTrue(result['applied'])

    def test_claude_bypass_is_off_by_default(self):
        with tempfile.TemporaryDirectory() as home:
            settings = os.path.join(home, '.claude/settings.json')
            native.atomic_write(settings, json.dumps({'permissions': {'allow': ['Read']}}).encode())
            native.dispatch({'action': 'apply', 'tool': 'claude', 'port': 3425, 'model': 'auto/claude-opus-5-5'}, home)
            config = json.loads(native.read_bytes(settings))
            self.assertNotIn('defaultMode', config['permissions'])
            self.assertEqual(config['permissions']['allow'], ['Read'])
            self.assertEqual(config['env']['ANTHROPIC_BASE_URL'], 'http://127.0.0.1:3425')

    def test_sync_preserves_provider_history_and_registers_live_models(self):
        with tempfile.TemporaryDirectory() as home:
            config = os.path.join(home, '.codex/config.toml')
            original = b'model_provider = "OpenAI"\nmodel = "codex/gpt-6.1-sol"\nmodel_reasoning_effort = "max"\n[model_providers.OpenAI]\nname = "OpenAI"\nbase_url = "http://127.0.0.1:3425/v1"\n'
            native.atomic_write(config, original)
            record = os.path.join(home, '.config/magpie-panel/native/codex.json')
            native.atomic_write(record, json.dumps({'active': True}).encode())
            template = {'models': [{'slug': 'gpt-6.1-sol', 'model_messages': {'instructions': 'unrelated'}, 'service_tiers': ['fast']}]}
            proc = type('Result', (), {'stdout': json.dumps(template)})()
            with patch.object(native.subprocess, 'run', return_value=proc):
                result = native.dispatch({'action': 'catalog', 'model': 'codex/gpt-6.1-sol',
                    'extra': ['workbuddy-ai/deepseek-v4.1-flash'],
                    'metadata': {'workbuddy-ai/deepseek-v4.1-flash': {'variants': {'high': {'reasoningEffort': 'high'}}}}}, home)
            content = native.read_bytes(config).decode()
            self.assertIn('model_provider = "OpenAI"', content)
            self.assertIn('model_reasoning_effort = "max"', content)
            self.assertIn('name = "magpie"', content)
            self.assertIn(json.dumps(result['catalog']), content)
            self.assertTrue(os.path.isabs(result['catalog']))
            with open(result['catalog'], encoding='utf-8') as handle:
                models = json.load(handle)['models']
            model = next(m for m in models if m['slug'].startswith('workbuddy'))
            self.assertEqual([x['effort'] for x in model['supported_reasoning_levels']], ['high'])
            self.assertNotIn('model_messages', model)
            self.assertNotIn('service_tiers', model)
            self.assertEqual(native.read_bytes(config + '.magpie-panel.bak'), original)


if __name__ == '__main__':
    unittest.main()
