// SPDX-License-Identifier: GPL-3.0-or-later
/*
 *  tvheadend, mobile web user interface
 *  Copyright (C) 2026 Tvheadend contributors
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#include "tvheadend.h"
#include "http.h"
#include "webui.h"
#include "filebundle.h"

/*
 * The mobile UI is a small, dependency-free single-page app for phones and
 * tablets (Now / Guide / Search / Recordings). It needs no build step: its
 * files live under src/webui/static/mobile, so they are bundled and
 * installed together with the rest of src/webui/static. This route only
 * gives the app a stable mount point at {webroot}/mobile/ -- the app derives
 * every server URL (api/, comet/, stream/, ...) from that location, and all
 * data flows through the regular JSON API with its usual permission checks.
 * Phones are sent here from the server root (page_root() in webui.c).
 */
#define MOBILE_ROOT "src/webui/static/mobile"

/* The UI is a flat set of files, so only plain names are valid: this rules
 * out directories ("." and "./"), traversal and hidden files up front. */
static int
mobile_name_valid(const char *name)
{
  const char *p;

  if (name[0] == '\0' || name[0] == '.')
    return 0;
  for (p = name; *p; p++)
    if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
          (*p >= '0' && *p <= '9') || *p == '.' || *p == '-' || *p == '_'))
      return 0;
  return 1;
}

static int
mobile_file_exists(const char *name)
{
  char path[256];
  fb_file *fp;

  if (snprintf(path, sizeof(path), "%s/%s", MOBILE_ROOT, name) >= (int)sizeof(path))
    return 0;
  if ((fp = fb_open(path, 0, 0)) == NULL)
    return 0;
  fb_close(fp);
  return 1;
}

static int
page_mobile(http_connection_t *hc, const char *remain, void *opaque)
{
  const char *q;
  size_t l;

  if (remain == NULL) {
    /* http_resolve() leaves remain NULL both for "/mobile" and for
     * "/mobile/?args". Send the former to the directory form, so that the
     * page's relative asset URLs resolve below /mobile/; serve the index for
     * the latter (redirecting it would loop). */
    q = strchr(hc->hc_url, '?');
    l = q ? (size_t)(q - hc->hc_url) : strlen(hc->hc_url);
    if (l == 0 || hc->hc_url[l - 1] != '/') {
      /* Absolute path: http_redirect() prefixes the webroot. */
      http_redirect(hc, "/mobile/", &hc->hc_req_args, 0);
      return 0;
    }
    remain = "";
  }

  if (remain[0] == '\0')
    return page_static_file(hc, "index.html", opaque);

  /* Unknown names are a plain 404 rather than page_static_file()'s
   * "failed to open" error. */
  if (!mobile_name_valid(remain) || !mobile_file_exists(remain))
    return HTTP_STATUS_NOT_FOUND;
  return page_static_file(hc, remain, opaque);
}

void
mobile_init(void)
{
  http_path_add("/mobile", (void *)MOBILE_ROOT, page_mobile,
                ACCESS_WEB_INTERFACE);
}
