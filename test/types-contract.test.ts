import assert from 'node:assert/strict'
import test from 'node:test'

import type { Manifest } from '../src/types.ts'

type RequiredProperty<T, K extends keyof T> = {} extends Pick<T, K> ? false : true

const manifestPluginVersionIsRequired: RequiredProperty<Manifest, 'pluginVersion'> = true

test('Manifest keeps pluginVersion required at the type boundary', () => {
  assert.equal(manifestPluginVersionIsRequired, true)
})
