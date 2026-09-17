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

  it('makes Crosshair available only in the MPR layout', () => {
    const baseProps = { activeTool: 'WindowLevel' as const, invert: false, flipHorizontal: false, flipVertical: false, cineEnabled: false, showSeries: false, showMetadata: false };
    const stack = mount(ToolbarPanel, { props: { ...baseProps, layout: '1x1' } });
    const mpr = mount(ToolbarPanel, { props: { ...baseProps, layout: 'mpr' } });
    const stackCrosshair = stack.findAll('button').find((button) => button.text() === 'Crosshair');
    const mprCrosshair = mpr.findAll('button').find((button) => button.text() === 'Crosshair');

    expect(stackCrosshair?.attributes('disabled')).toBeDefined();
    expect(stackCrosshair?.attributes('title')).toBe('Available in MPR layout only');
    expect(mprCrosshair?.attributes('disabled')).toBeUndefined();
  });
});
