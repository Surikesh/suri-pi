import Foundation

// A remembered recovery path is not an explicit UI pin. Fresh native launches
// follow the same host entry point as browser launches; old paths remain usable
// only through the explicit rollback action.
enum BootstrapNavigation {
    private static func components(origin: String) -> URLComponents? {
        guard let value = URLComponents(string: origin), value.scheme == "http",
              value.host == "127.0.0.1", value.port != nil,
              value.user == nil, value.password == nil else { return nil }
        return value
    }

    static func url(origin: String, nonce: String, benchmark: Bool = false) -> URL? {
        guard var url = components(origin: origin) else { return nil }
        url.path = "/"
        url.queryItems = [URLQueryItem(name: "shell", value: "2")]
        if benchmark {
            url.queryItems?.append(URLQueryItem(name: "nativeBenchmark", value: "1"))
        }
        url.fragment = "nonce=" + nonce
        return url.url
    }

    static func appURL(origin: URL, path: String) -> URL? {
        guard components(origin: origin.absoluteString) != nil,
              let resolved = URL(string: path, relativeTo: origin)?.absoluteURL,
              resolved.scheme == origin.scheme, resolved.host == origin.host,
              resolved.port == origin.port, resolved.user == nil, resolved.password == nil,
              var target = URLComponents(url: resolved, resolvingAgainstBaseURL: false)
        else { return nil }
        var query = target.queryItems ?? []
        query.removeAll { $0.name == "shell" }
        query.append(URLQueryItem(name: "shell", value: "2"))
        target.queryItems = query
        target.fragment = nil
        return target.url
    }
}
