/* SQLite's operating system hooks: the VFS vfs.sub gives, registered as SQLite starts. */
#include "sqlite3.h"

static sqlite3_vfs *given;

void os_set_vfs(sqlite3_vfs *vfs) { given = vfs; }

int sqlite3_os_init(void) { return given ? sqlite3_vfs_register(given, 1) : SQLITE_ERROR; }

int sqlite3_os_end(void) { return SQLITE_OK; }
