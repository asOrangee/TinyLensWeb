# Exact preflight modeling mask

The Modeling Mask excludes only pixels outside the fixed 4″ modeling circle and exact segmentation-map pixels selected by the System Inspector; it does not automatically dilate contaminants. The mask is the common input to every stage, so this keeps the likelihood domain explicit and reproducible rather than hiding a morphology rule in Python. Contamination that cannot be represented by those exact segments is routed to human review at preflight.
