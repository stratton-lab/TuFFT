import assert from "node:assert/strict";
import test from "node:test";
import { analysisPreviewSignature, defaultDraft, parseSettingsFile, previewSignature, toJobConfig } from "../../src/types/job.ts";
import { normalizeVideoPath } from "../../src/utils/paths.ts";

test("native canonical Windows paths match dialog and saved ROI paths", () => {
  assert.equal(normalizeVideoPath("\\\\?\\C:\\Videos\\sample.avi"), normalizeVideoPath("c:/Videos/sample.avi"));
  assert.equal(normalizeVideoPath("\\\\?\\UNC\\server\\share\\sample.avi"), normalizeVideoPath("\\\\server\\share\\sample.avi"));
});

test("new in-vitro jobs save both CBF estimators in both CSV tables", () => {
  const draft = structuredClone(defaultDraft);
  const config = toJobConfig(draft, "default-output-test");
  assert.equal(config.pipeline_params.SAVE_BATCH_SUMMARY, true);
  assert.equal(config.pipeline_params.SAVE_TUFT_TABLE, true);
  for (const column of ["joint_peak_cbf_mean_hz", "joint_peak_cbf_std_hz", "pixel_mean_cbf_mean_hz", "pixel_mean_cbf_std_hz"]) {
    assert.ok(config.summary_columns.includes(column), column);
  }
  for (const column of ["joint_spectral_cbf_hz", "pixel_dominant_cbf_mean_hz", "pixel_dominant_cbf_std_hz"]) {
    assert.ok(config.tuft_columns.includes(column), column);
  }
});

test("explicit output deselection is preserved in the final job", () => {
  const draft = structuredClone(defaultDraft);
  draft.outputs.batchSummary = false;
  draft.outputs.perTuftTable = false;
  draft.outputs.summaryColumns = ["tuft_count"];
  draft.outputs.tuftColumns = ["area_px"];
  const config = toJobConfig(draft, "selected-output-test");
  assert.equal(config.pipeline_params.SAVE_BATCH_SUMMARY, false);
  assert.equal(config.pipeline_params.SAVE_TUFT_TABLE, false);
  assert.deepEqual(config.summary_columns, ["tuft_count"]);
  assert.deepEqual(config.tuft_columns, ["area_px"]);
});

test("imported plot ranges use the CBF band unless explicitly saved", () => {
  const parameters = {
    schema_version: 1,
    analysis_type: "in_vitro",
    pipeline_params: { BAND_LO: 10, BAND_HI: 45 },
  };
  const inherited = parseSettingsFile(parameters, "in_vitro");
  assert.equal(inherited.settings.plotFrequencyMin, 10);
  assert.equal(inherited.settings.plotFrequencyMax, 45);
  const overridden = parseSettingsFile({ ...parameters, pipeline_params: { ...parameters.pipeline_params, RAW_FREQUENCY_MIN_HZ: 0, RAW_FREQUENCY_MAX_HZ: 100 } }, "in_vitro");
  assert.equal(overridden.settings.plotFrequencyMin, 0);
  assert.equal(overridden.settings.plotFrequencyMax, 100);
});

test("back-and-forth analysis edits invalidate downstream previews but preserve the FFT", () => {
  const draft = structuredClone(defaultDraft);
  const fft = previewSignature(draft);
  const analysis = analysisPreviewSignature(draft.settings);
  for (const patch of [{ bandLow: 12, bandHigh: 40 }, { minTuftSize: 200 }, { evidenceGaussianSigma: 2 }]) {
    const changed = { ...draft, settings: { ...draft.settings, ...patch } };
    assert.equal(previewSignature(changed), fft);
    assert.notEqual(analysisPreviewSignature(changed.settings), analysis);
  }
  const changedRoi = { ...draft, settings: { ...draft.settings, radius: draft.settings.radius - 10 } };
  assert.notEqual(previewSignature(changedRoi), fft);
  assert.equal(analysisPreviewSignature(structuredClone(draft.settings)), analysis);
});
