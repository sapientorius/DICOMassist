import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { makeStudy } from '../test/fixtures/study';
import type { SelectionPlan } from '../llm/types';
import PlanPreview from './PlanPreview.vue';

const plan: SelectionPlan = {
  reasoning: 'test', totalImages: 8, targetSeries: '1', sliceRange: [1, 20], samplingStrategy: 'uniform', samplingParam: 8, windowCenter: 40, windowWidth: 400,
  selections: [{ seriesNumber: '1', role: 'primary', rationale: 'test', sliceRange: [1, 20], samplingStrategy: 'uniform', samplingParam: 8, windowCenter: 40, windowWidth: 400, coverageGoal: 'Whole organ' }],
};

describe('PlanPreview', () => {
  it('accounts for its overview montage and prevents a plan above the approved image budget', async () => {
    const wrapper = mount(PlanPreview, {
      props: {
        plan,
        metadata: makeStudy(),
        budget: { requestedImages: 9, approvedImages: 8, sourcePixelsPerImage: 1, pixelsPerImage: 1, estimatedImageTokens: 1, estimatedInputTokens: 1, availableInputTokens: 1, wasAdjusted: true, warnings: [] },
      },
    });
    expect(wrapper.text()).toContain('8 detail + 1 overview / 8 images');
    expect(wrapper.get('button.bg-blue-600').attributes('disabled')).toBeDefined();
    const imageInput = wrapper.findAll('input[type="number"]').at(2);
    await imageInput?.setValue('7');
    expect(wrapper.get('button.bg-blue-600').attributes('disabled')).toBeUndefined();
  });
});

