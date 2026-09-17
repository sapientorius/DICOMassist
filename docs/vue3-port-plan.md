# Vue 3 port plan

1. Preserve and test the framework-neutral DICOM, filtering, and LLM modules.
2. Replace the React entry point, build setup, and components with Vue 3 single-file components.
3. Move stateful behavior into composables, with explicit Cornerstone lifecycle cleanup.
4. Add unit tests for metadata geometry, slice selection, provider configuration, and Vue UI behavior.
5. Add Playwright smoke tests for the production UI and enforce lint, unit, E2E, and build gates.

The port deliberately keeps the local-file and direct-provider architecture. No DICOM data is sent to a DICOMassist server.
