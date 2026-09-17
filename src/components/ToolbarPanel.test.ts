import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ToolbarPanel from './ToolbarPanel.vue';

describe('ToolbarPanel', () => {
  it('emits Vue model updates for an activated viewer tool', async () => {
    const wrapper = mount(ToolbarPanel, { props: { activeTool: 'WindowLevel', layout: '1x1', invert: false, flipHorizontal: false, flipVertical: false, cineEnabled: false, showSeries: false, showMetadata: false } });
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('update:activeTool')?.[0]).toEqual(['WindowLevel']);
    await wrapper.get('select[aria-label="Viewport layout"]').setValue('2x2');
    expect(wrapper.emitted('update:layout')?.[0]).toEqual(['2x2']);
  });
});
