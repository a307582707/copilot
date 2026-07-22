import zipfile
import xml.etree.ElementTree as ET
import sys
import os

def docx_to_text(path):
    if not os.path.exists(path):
        return f"Error: File not found {path}"
    
    try:
        with zipfile.ZipFile(path) as z:
            xml_content = z.read('word/document.xml')
            tree = ET.fromstring(xml_content)
            
            # Namespaces
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            
            text_parts = []
            for p in tree.findall('.//w:p', ns):
                p_text = []
                for t in p.findall('.//w:t', ns):
                    if t.text:
                        p_text.append(t.text)
                if p_text:
                    text_parts.append(''.join(p_text))
            
            return '\n\n'.join(text_parts)
    except Exception as e:
        return f"Error reading docx: {e}"

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python docx_to_md.py <docx_path>")
        sys.exit(1)
        
    path = sys.argv[1]
    print(docx_to_text(path))
