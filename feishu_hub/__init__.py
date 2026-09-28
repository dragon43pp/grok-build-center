"""Grok Build Center —— 会话中心。

版本号只在这里定义一次。放这儿是因为要用它的地方横跨三层：
exe 的入口（tools/app.py）、图形前台（feishu_hub/ui.py）、安装包（installer/）。
三处各写一份的结果必然是装完之后 `version` 和「添加或删除程序」里对不上。
"""

__version__ = "1.1.0"
