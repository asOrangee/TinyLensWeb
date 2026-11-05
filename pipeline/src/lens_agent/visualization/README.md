+# Vendored STCI renderer

This directory contains the array-only rendering core derived from STCI 0.1.3 (Tian_color.py), copyright Tian Li, under the included MIT licence.

It intentionally excludes FITS/raster input and output and network download code. The supported internal API accepts aligned NumPy arrays only: make_color_array and make_mono_array.

