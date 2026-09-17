import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SettingsPanel from './SettingsPanel.vue';
import type { ProviderConfig } from '../llm/types';

const config: ProviderConfig = {
  provider: 'ollama',
  profiles: { ollama: { textModel: 'planner', visionModel: 'vision' } },
};

describe('SettingsPanel analysis profiles', () => {
  it('stores the selected deep-analysis budget in the active provider profile', async () => {
    const wrapper = mount(SettingsPanel, { props: { open: true, config } });
    const deepButton = wrapper.findAll('button').find((button) => button.text() === 'Deep analysis');
    expect(deepButton).toBeDefined();
    await deepButton!.trigger('click');
    const changed = wrapper.emitted('change')?.at(-1)?.[0] as ProviderConfig;
    expect(changed.profiles.ollama?.analysis).toMatchObject({ profile: 'deep', maxImages: 32, maxRefinementRounds: 2, contextWindowTokens: 65_536 });
  });
});
