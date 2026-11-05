import Foundation
import Vision
import ImageIO

// Read printed labels only. No image data are converted into scientific arrays.
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let images = try JSONSerialization.jsonObject(with: input) as! [String]
    var output = [[[String: Any]]]()
    for encoded in images {
        guard let data = Data(base64Encoded: encoded),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(1) }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.usesCPUOnly = true
        request.recognitionLanguages = ["en-US"]
        try VNImageRequestHandler(cgImage: image).perform([request])
        output.append((request.results ?? []).compactMap { result in
            guard let text = result.topCandidates(1).first else { return nil }
            let box = result.boundingBox
            return ["text": text.string, "confidence": text.confidence,
                    "box": [box.minX, box.minY, box.width, box.height]]
        })
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output))
} catch {
    exit(1)
}
