package main

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"net/url"
	"os"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

const customHeadScriptEnvName = "RENEWLET_CUSTOM_HEAD_SCRIPT"

type customHeadScript struct {
	Markup         string
	ScriptOrigin   string
	ConnectOrigins []string
}

type customHeadScriptFS struct {
	fs.FS
}

func (fsys customHeadScriptFS) Open(name string) (fs.File, error) {
	file, err := fsys.FS.Open(name)
	if err != nil || name != "index.html" {
		return file, err
	}
	defer file.Close()

	content, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if script, ok := customHeadScriptFromEnv(); ok {
		content = injectCustomHeadScript(content, script)
	}
	return &staticMemoryFile{
		Reader: bytes.NewReader(content),
		info:   staticFileInfo{FileInfo: info, size: int64(len(content))},
	}, nil
}

type staticMemoryFile struct {
	*bytes.Reader
	info fs.FileInfo
}

func (file *staticMemoryFile) Stat() (fs.FileInfo, error) {
	return file.info, nil
}

func (file *staticMemoryFile) Close() error {
	return nil
}

type staticFileInfo struct {
	fs.FileInfo
	size int64
}

func (info staticFileInfo) Size() int64 {
	return info.size
}

func customHeadScriptFromEnv() (customHeadScript, bool) {
	script, err := parseCustomHeadScript(os.Getenv(customHeadScriptEnvName))
	if err != nil {
		return customHeadScript{}, false
	}
	return script, script.Markup != ""
}

func validateCustomHeadScriptEnv() error {
	_, err := parseCustomHeadScript(os.Getenv(customHeadScriptEnvName))
	return err
}

func parseCustomHeadScript(raw string) (customHeadScript, error) {
	markup := strings.TrimSpace(raw)
	if markup == "" {
		return customHeadScript{}, nil
	}
	if !strings.HasSuffix(strings.ToLower(markup), "</script>") {
		return customHeadScript{}, errors.New("custom head script must include an explicit closing script tag")
	}
	if err := rejectDuplicateRawScriptAttributes(markup); err != nil {
		return customHeadScript{}, err
	}

	nodes, err := html.ParseFragment(strings.NewReader(markup), &html.Node{Type: html.ElementNode, DataAtom: atom.Head, Data: "head"})
	if err != nil {
		return customHeadScript{}, err
	}

	var scriptNode *html.Node
	for _, node := range nodes {
		if node.Type == html.TextNode && strings.TrimSpace(node.Data) == "" {
			continue
		}
		if node.Type != html.ElementNode || node.Data != "script" || scriptNode != nil {
			return customHeadScript{}, errors.New("custom head script must be a single script tag")
		}
		scriptNode = node
	}
	if scriptNode == nil {
		return customHeadScript{}, errors.New("custom head script is missing script tag")
	}
	if !scriptHasNoInlineContent(scriptNode) {
		return customHeadScript{}, errors.New("custom head script must not contain inline JavaScript")
	}
	// RENEWLET_CUSTOM_HEAD_SCRIPT 是原样注入能力；只接受单个外链 script，避免部署变量变成任意 HTML/XSS 入口。
	seenAttrs := map[string]bool{}
	for _, attr := range scriptNode.Attr {
		key := strings.ToLower(strings.TrimSpace(attr.Key))
		if key == "" || seenAttrs[key] {
			return customHeadScript{}, errors.New("custom head script must not contain duplicate or empty attributes")
		}
		seenAttrs[key] = true
		if strings.HasPrefix(key, "on") {
			return customHeadScript{}, errors.New("custom head script must not contain inline event handlers")
		}
	}
	src, err := scriptAttrValue(scriptNode, "src")
	if err != nil || src == "" {
		return customHeadScript{}, errors.New("custom head script must contain one src attribute")
	}

	scriptOrigin, err := httpURLOrigin(src)
	if err != nil {
		return customHeadScript{}, err
	}
	connectOrigins := []string{scriptOrigin}
	if hostURL, err := scriptAttrValue(scriptNode, "data-host-url"); err == nil && hostURL != "" {
		if origin, err := httpURLOrigin(hostURL); err == nil {
			connectOrigins = appendUniqueString(connectOrigins, origin)
		}
	}

	return customHeadScript{
		Markup:         markup,
		ScriptOrigin:   scriptOrigin,
		ConnectOrigins: connectOrigins,
	}, nil
}

func rejectDuplicateRawScriptAttributes(markup string) error {
	// x/net/html 会按浏览器口径丢弃重复属性；安全校验必须先看原始 opening tag，避免 SRC/src 这类大小写重复绕过。
	keys, err := rawScriptAttributeKeys(markup)
	if err != nil {
		return err
	}
	seenAttrs := map[string]bool{}
	for _, key := range keys {
		if key == "" || seenAttrs[key] {
			return errors.New("custom head script must not contain duplicate or empty attributes")
		}
		seenAttrs[key] = true
	}
	return nil
}

func rawScriptAttributeKeys(markup string) ([]string, error) {
	const scriptTag = "<script"
	lower := strings.ToLower(markup)
	if !strings.HasPrefix(lower, scriptTag) {
		return nil, errors.New("custom head script must be a single script tag")
	}
	pos := len(scriptTag)
	if pos < len(markup) && !isHTMLAttributeBoundary(markup[pos]) {
		return nil, errors.New("custom head script must be a single script tag")
	}

	keys := []string{}
	for pos < len(markup) {
		pos = skipHTMLSpace(markup, pos)
		if pos >= len(markup) {
			return nil, errors.New("custom head script must include an opening script tag")
		}
		if markup[pos] == '>' {
			return keys, nil
		}
		if markup[pos] == '/' {
			return nil, errors.New("custom head script must not be self-closing")
		}
		start := pos
		for pos < len(markup) && !isHTMLAttributeBoundary(markup[pos]) && markup[pos] != '=' {
			pos++
		}
		key := strings.ToLower(strings.TrimSpace(markup[start:pos]))
		keys = append(keys, key)
		pos = skipHTMLSpace(markup, pos)
		if pos < len(markup) && markup[pos] == '=' {
			next, err := skipHTMLAttributeValue(markup, pos+1)
			if err != nil {
				return nil, err
			}
			pos = next
		}
	}
	return nil, errors.New("custom head script must include an opening script tag")
}

func skipHTMLAttributeValue(markup string, pos int) (int, error) {
	pos = skipHTMLSpace(markup, pos)
	if pos >= len(markup) {
		return pos, errors.New("custom head script must not contain malformed attributes")
	}
	if markup[pos] == '"' || markup[pos] == '\'' {
		quote := markup[pos]
		pos++
		for pos < len(markup) && markup[pos] != quote {
			pos++
		}
		if pos >= len(markup) {
			return pos, errors.New("custom head script must not contain malformed attributes")
		}
		return pos + 1, nil
	}
	for pos < len(markup) && !isHTMLAttributeBoundary(markup[pos]) {
		pos++
	}
	return pos, nil
}

func skipHTMLSpace(markup string, pos int) int {
	for pos < len(markup) {
		switch markup[pos] {
		case ' ', '\t', '\n', '\f', '\r':
			pos++
		default:
			return pos
		}
	}
	return pos
}

func isHTMLAttributeBoundary(char byte) bool {
	switch char {
	case ' ', '\t', '\n', '\f', '\r', '/', '>':
		return true
	default:
		return false
	}
}

func scriptHasNoInlineContent(node *html.Node) bool {
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if child.Type != html.TextNode || strings.TrimSpace(child.Data) != "" {
			return false
		}
	}
	return true
}

func scriptAttrValue(node *html.Node, name string) (string, error) {
	var value string
	found := false
	for _, attr := range node.Attr {
		if strings.EqualFold(attr.Key, name) {
			if found {
				return "", errors.New("duplicate script attribute")
			}
			value = strings.TrimSpace(attr.Val)
			found = true
		}
	}
	return value, nil
}

func httpURLOrigin(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	scheme := strings.ToLower(parsed.Scheme)
	if !parsed.IsAbs() || (scheme != "http" && scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return "", errors.New("custom head script src must be an absolute http(s) URL without userinfo")
	}
	return scheme + "://" + strings.ToLower(parsed.Host), nil
}

func injectCustomHeadScript(content []byte, script customHeadScript) []byte {
	if script.Markup == "" {
		return content
	}
	if bytes.Contains(content, []byte(script.Markup)) {
		return content
	}
	index := bytes.LastIndex(bytes.ToLower(content), []byte("</head>"))
	if index < 0 {
		return content
	}
	var output bytes.Buffer
	output.Grow(len(content) + len(script.Markup) + 8)
	output.Write(content[:index])
	output.WriteString("\n    ")
	output.WriteString(script.Markup)
	output.WriteString("\n  ")
	output.Write(content[index:])
	return output.Bytes()
}

func appendUniqueString(items []string, value string) []string {
	for _, item := range items {
		if item == value {
			return items
		}
	}
	return append(items, value)
}
