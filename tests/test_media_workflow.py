import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
import desktop_runtime
import media_engine
import server
import wake_gateway

class MediaWorkflowTests(unittest.TestCase):
    def request(self, root, kind='video', **extra):
        project = Path(root) / 'project'
        project.mkdir(exist_ok=True)
        return dict(type=kind, prompt='test', project_path=str(project), **extra)

    def test_video_settings_are_native_720_and_download_1080(self):
        with tempfile.TemporaryDirectory() as td:
            job = media_engine.create_job(td, self.request(td))
            self.assertEqual(job['generation_settings']['generation_resolution'], '720p')
            self.assertEqual(job['generation_settings']['download_quality'], '1080p')
            with self.assertRaisesRegex(ValueError, 'download_quality=1080p'):
                media_engine.create_job(td, self.request(td, generation_resolution='1080p'))
            with self.assertRaisesRegex(ValueError, 'download_quality=1080p'):
                media_engine.create_job(td, self.request(td, generation_settings={'generation_resolution': '4k'}))
            self.assertEqual(len(list((Path(td)/'media'/'jobs').glob('media-*.json'))), 1)

    def test_sfx_policy_cannot_be_overridden_by_video_settings(self):
        with tempfile.TemporaryDirectory() as td:
            req = media_engine.normalize_generate_request(td, self.request(td, 'sound_effect',
                generation_resolution='720p', download_quality='1080p', audio_only=False,
                wait_for_upscale=True, generation_settings={'generation_resolution':'1080p'}))
            settings = req['generation_settings']
            self.assertEqual(settings['generation_resolution'], '360p')
            self.assertEqual(settings['download_quality'], 'source')
            self.assertFalse(settings['wait_for_upscale'])
            self.assertTrue(settings['audio_only'])

    def test_omni_reference_alias_is_an_ingredient_and_end_frame_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            req = self.request(td)
            image = Path(req['project_path'])/'car.png'
            image.write_bytes(b'image')
            job = media_engine.create_job(td, dict(req, first_frame='car.png', references=['car.png']))
            stored = media_engine.load_job(td, job['job_id'])
            self.assertEqual(job['reference_mode'], 'ingredients')
            self.assertIn('does not guarantee', job['reference_note'])
            self.assertEqual(len(stored['resolved_references']), 1)
            self.assertEqual(stored['resolved_references'][0]['roles'], ['first_frame'])
            with self.assertRaisesRegex(ValueError, 'does not support last_frame'):
                media_engine.create_job(td, dict(req, last_frame='car.png'))
            with self.assertRaisesRegex(ValueError, 'Frames are unavailable'):
                media_engine.create_job(td, dict(req, reference_mode='frames', first_frame='car.png'))

    def test_old_asset_metadata_still_resolves_exact_reference_identity(self):
        with tempfile.TemporaryDirectory() as td:
            image_job = media_engine.create_job(td, self.request(td, 'image'))
            image = Path(td)/'project'/'Generated Assets'/'Images'/'car.png'
            image.write_bytes(b'image')
            expected = '7edb6cbd-6555-4fa0-a82a-1f2126efa59d'
            asset = media_engine.register_asset(td, image_job['job_id'], image,
                metadata={'download_action':{'result_key':expected}})
            video = media_engine.create_job(td, self.request(td, references=[asset['asset_id']]))
            reference = media_engine.load_job(td,video['job_id'])['resolved_references'][0]
            self.assertEqual(reference['provider_asset_id'],expected)
            self.assertEqual(video['parent_asset_ids'],[asset['asset_id']])

    def test_transform_preserves_reference_and_download_policy(self):
        with tempfile.TemporaryDirectory() as td:
            image_job = media_engine.create_job(td, self.request(td, 'image'))
            image = Path(td)/'project'/'Generated Assets'/'Images'/'car.png'
            image.write_bytes(b'image')
            asset = media_engine.register_asset(td,image_job['job_id'],image)
            job = media_engine.create_transform_job(td, dict(asset_id=asset['asset_id'],operation='video_edit',
                reference_mode='ingredients',generation_resolution='360p',download_quality='source',wait_for_upscale=False))
            self.assertEqual(job['generation_settings']['generation_resolution'],'360p')
            self.assertEqual(job['generation_settings']['download_quality'],'source')
            self.assertFalse(job['generation_settings']['wait_for_upscale'])
            with self.assertRaisesRegex(ValueError,'Frames are unavailable'):
                media_engine.create_transform_job(td,dict(asset_id=asset['asset_id'],operation='video_edit',reference_mode='frames'))

    def test_wake_error_is_reported_while_durable_job_is_preserved(self):
        with tempfile.TemporaryDirectory() as td, patch.object(server,'ROOT',Path(td)), patch.object(server,'desktop_control',side_effect=RuntimeError('startup unavailable')):
            result=server.tool_call('media_generate',self.request(td))
            self.assertEqual(result['runtime']['state'],'unavailable')
            self.assertIn('startup unavailable',result['runtime']['error'])
            self.assertEqual(media_engine.load_job(td,result['job_id'])['state'],'queued')

    def test_media_jobs_keep_core_awake_but_auth_blocked_jobs_can_sleep(self):
        with tempfile.TemporaryDirectory() as td:
            job=media_engine.create_job(td,self.request(td))
            self.assertTrue(wake_gateway.active_jobs(td))
            media_engine.update_job_state(td,job['job_id'],'needs_user_auth')
            self.assertFalse(wake_gateway.active_jobs(td))

class DesktopColdStartTests(unittest.TestCase):
    def source_install(self, root):
        binary=Path(root)/'node_modules'/'electron'/'dist'/'electron.exe'
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b'test executable')
        app=Path(root)/'apps'/'desktop'
        app.mkdir(parents=True)
        (app/'package.json').write_text('{}')
        return binary,app

    def publish(self, root):
        target=Path(root)/'.teamyra-desktop'/'runtime.json'
        target.parent.mkdir(exist_ok=True)
        target.write_text(json.dumps(dict(protocol=1,pid=123,ready=True,runtime_root=str(Path(root).resolve()),updated_at=time.time())))

    def test_concurrent_cold_requests_start_one_hidden_process_and_wait_for_ready(self):
        with tempfile.TemporaryDirectory() as td:
            binary,app=self.source_install(td)
            child=Mock();child.poll.return_value=None
            def spawn(*args,**kw):
                self.assertEqual(args[0],[str(binary),str(app),'--background'])
                self.assertNotIn('ELECTRON_RUN_AS_NODE',kw['env'])
                self.assertEqual(kw['env']['TEAMYRA_ROOT'],str(Path(td).resolve()))
                self.publish(td)
                return child
            with patch.object(desktop_runtime.subprocess,'Popen',side_effect=spawn) as popen, patch.object(desktop_runtime,'process_alive',return_value=True), patch.dict('os.environ',{'ELECTRON_RUN_AS_NODE':'1'}):
                with ThreadPoolExecutor(max_workers=4) as pool:
                    results=list(pool.map(lambda _:desktop_runtime.ensure_desktop_ready(td),range(4)))
                self.assertEqual(popen.call_count,1)
                self.assertTrue(all(result['state']=='ready' for result in results))
                self.assertFalse((Path(td)/'.teamyra-desktop'/'start.lock').exists())

    def test_malformed_stale_lock_and_runtime_recover(self):
        with tempfile.TemporaryDirectory() as td:
            self.source_install(td)
            state=Path(td)/'.teamyra-desktop';state.mkdir()
            lock=state/'start.lock';lock.write_text('{broken')
            import os
            os.utime(lock,(time.time()-10,time.time()-10))
            (state/'runtime.json').write_text(json.dumps(dict(ready=True,protocol=1,updated_at='bad')))
            self.assertFalse(desktop_runtime.desktop_ready(td))
            child=Mock();child.poll.return_value=None
            def spawn(*args,**kw):
                self.publish(td)
                return child
            with patch.object(desktop_runtime.subprocess,'Popen',side_effect=spawn) as popen, patch.object(desktop_runtime,'process_alive',return_value=True):
                self.assertTrue(desktop_runtime.ensure_desktop_ready(td)['started'])
                self.assertEqual(popen.call_count,1)
            self.assertFalse(lock.exists())

    def test_packaged_launch_uses_recorded_binary_without_source_dependencies(self):
        with tempfile.TemporaryDirectory() as td:
            binary=Path(td)/'TEAMYRA-packaged.exe';binary.write_bytes(b'test')
            data=Path(td)/'runtime';state=data/'.teamyra-desktop';state.mkdir(parents=True)
            (state/'launch.json').write_text(json.dumps(dict(executable=str(binary),packaged=True,runtime_root=str(data))))
            self.assertEqual(desktop_runtime.desktop_command(data,{}),[str(binary),'--background'])

    def test_startup_failure_cleans_lock_and_is_not_ready(self):
        with tempfile.TemporaryDirectory() as td:
            self.source_install(td)
            child=Mock();child.poll.return_value=7
            with patch.object(desktop_runtime.subprocess,'Popen',return_value=child):
                with self.assertRaisesRegex(RuntimeError,'exit code 7'):
                    desktop_runtime.ensure_desktop_ready(td)
            self.assertFalse((Path(td)/'.teamyra-desktop'/'start.lock').exists())
            self.assertFalse(desktop_runtime.desktop_ready(td))

if __name__=='__main__': unittest.main()
