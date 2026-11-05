# Binary preflight disposition

The System Inspector returns `model` or `human_review`, contaminant segmentation IDs, and a reason. Numeric confidence and a threshold are excluded: an ambiguous or non-simple system is routed directly to human review, while an explicitly modelable system proceeds to mask creation. This prevents an uncalibrated language-model confidence value from silently overriding the inspector's categorical scientific judgment.
