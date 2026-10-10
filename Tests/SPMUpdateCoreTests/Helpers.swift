import Foundation
@testable import SPMUpdateCore
import XCTest

enum Fixtures {
    static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
    static var pbxproj: String {
        try! String(contentsOf: dir.appendingPathComponent("App.xcodeproj/project.pbxproj"), encoding: .utf8)
    }
}

func dep(_ req: Requirement, name: String = "Pkg") -> Dependency {
    Dependency(name: name, identity: name.lowercased(), source: .remote, url: "https://example.com/\(name).git",
               fetchUrl: nil, req: req, handle: .none)
}

func versions(_ list: [String]) -> TagResult {
    .versions(list.map { SemVer(strict: $0)! })
}

func v(_ s: String) -> SemVer { SemVer(strict: s)! }

func sh(_ args: [String], cwd: String? = nil) throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = args
    if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try p.run()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { throw ToolError("\(args.joined(separator: " ")) failed") }
}

/// Creates a unique directory; `prefix` is either a name (under the system temp dir) or an absolute path prefix.
func makeTempDir(_ prefix: String) -> String {
    let base = prefix.hasPrefix("/") ? prefix : FileManager.default.temporaryDirectory.appendingPathComponent(prefix).path
    let path = "\(base)-\(UUID().uuidString)"
    try! FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    return path
}

/// A minimal HTTP/1.1 server for one canned handler, so the HTTP lookup path can be tested offline.
final class TinyHTTPServer: @unchecked Sendable {
    struct Request { var method: String; var path: String; var headers: [String: String]; var body: String }
    let port: Int
    private let fd: Int32
    private let handler: (Request) -> (status: Int, contentType: String, body: String)
    private let lock = NSLock()
    private var _seen: [Request] = []
    var seen: [Request] { lock.lock(); defer { lock.unlock() }; return _seen }

    init(_ handler: @escaping (Request) -> (status: Int, contentType: String, body: String)) throws {
        self.handler = handler
        #if canImport(Darwin)
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        #else
        let sock = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        #endif
        var one: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        #if canImport(Darwin)
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        #endif
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(sock, 16) == 0 else { throw ToolError("can't listen") }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(sock, $0, &len) }
        }
        fd = sock
        port = Int(UInt16(bigEndian: addr.sin_port))
        Thread { [self] in acceptLoop() }.start()
    }

    func stop() { close(fd) }

    private func acceptLoop() {
        while true {
            let client = accept(fd, nil, nil)
            guard client >= 0 else { return }
            Thread { [self] in serve(client) }.start()
        }
    }

    private func serve(_ client: Int32) {
        defer { close(client) }
        var data = [UInt8]()
        var buf = [UInt8](repeating: 0, count: 4096)
        var headerEnd: Int?
        var contentLength = 0
        while true {
            let n = read(client, &buf, buf.count)
            if n <= 0 { break }
            data += buf[0..<n]
            if headerEnd == nil, let r = String(decoding: data, as: UTF8.self).range(of: "\r\n\r\n") {
                let head = String(String(decoding: data, as: UTF8.self)[..<r.lowerBound])
                headerEnd = head.utf8.count + 4
                for line in head.split(separator: "\r\n") where line.lowercased().hasPrefix("content-length:") {
                    contentLength = Int(line.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) ?? 0
                }
            }
            if let h = headerEnd, data.count >= h + contentLength { break }
        }
        guard let h = headerEnd else { return }
        let lines = String(decoding: data[..<h], as: UTF8.self).split(separator: "\r\n")
        let first = lines.first?.split(separator: " ") ?? []
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let req = Request(method: first.count > 0 ? String(first[0]) : "", path: first.count > 1 ? String(first[1]) : "",
                          headers: headers, body: String(decoding: data[h...], as: UTF8.self))
        lock.lock(); _seen.append(req); lock.unlock()
        let res = handler(req)
        let response = "HTTP/1.1 \(res.status) X\r\nContent-Type: \(res.contentType)\r\nContent-Length: \(res.body.utf8.count)\r\nConnection: close\r\n\r\n\(res.body)"
        _ = response.withCString { write(client, $0, strlen($0)) }
    }
}
