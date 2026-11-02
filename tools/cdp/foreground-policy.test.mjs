import test from 'node:test';
import assert from 'node:assert/strict';
import {assertForegroundAllowed} from './foreground-policy.mjs';
test('foreground commands are rejected by default',()=>{
  for(const method of ['Page.bringToFront','Target.activateTarget']) assert.throws(()=>assertForegroundAllowed(method,{},false),/blocked/);
  for(const windowState of ['normal','maximized','fullscreen']) assert.throws(()=>assertForegroundAllowed('Browser.setWindowBounds',{bounds:{windowState}},false),/blocked/);
});
test('screenshots, viewport emulation and focus emulation stay available',()=>{
  for(const method of ['Page.captureScreenshot','Emulation.setDeviceMetricsOverride','Emulation.setFocusEmulationEnabled','Input.dispatchKeyEvent']) assert.doesNotThrow(()=>assertForegroundAllowed(method,{},false));
});
test('explicit visible-session authorization permits foreground calls',()=>{
  assert.doesNotThrow(()=>assertForegroundAllowed('Page.bringToFront',{},true));
});
