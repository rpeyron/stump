use axum::{
	extract::{Path, State},
	http::HeaderMap,
	middleware,
	response::IntoResponse,
	routing::get,
	Extension, Router,
};
use graphql::data::AuthContext;
use models::{
	entity::{library, library_config, media, series, user::AuthUser},
	shared::image_processor_options::SupportedImageFormat,
};
use sea_orm::{prelude::*, sea_query::Query, QuerySelect};
use stump_core::{
	config::StumpConfig,
	fs_utils::ContentType,
	image::thumbnail::{get_saved_thumbnail, get_thumbnail},
	media::processor::get_page,
	Ctx,
};

use crate::{
	config::state::AppState,
	errors::{APIError, APIResult},
	middleware::auth::auth_middleware,
	utils::{http::ImageResponse, serve_media},
};

pub(crate) fn mount(app_state: AppState) -> Router<AppState> {
	Router::new()
		.nest(
			"/media/{id}",
			Router::new()
				.route("/thumbnail", get(get_media_thumbnail_handler))
				.route("/page/{page}", get(get_media_page))
				.route("/file", get(get_media_file)),
		)
		.layer(middleware::from_fn_with_state(app_state, auth_middleware))
}

/// Download the file associated with the media.
pub(crate) async fn get_media_file(
	Path(id): Path<String>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
	headers: HeaderMap,
) -> APIResult<impl IntoResponse> {
	serve_media::serve_media_file(req, headers, ctx.conn.as_ref(), id).await
}

pub(crate) async fn get_media_thumbnail(
	book: &media::MediaThumbSelect,
	image_format: Option<SupportedImageFormat>,
	config: &StumpConfig,
) -> APIResult<(ContentType, Vec<u8>)> {
	// Note: This doesn't hard-fail because if the saved thumbnail is missing or corrupt, we want
	// to just pull something else instead of erroring out entirely.
	if let Some(path) = &book.thumbnail_path {
		match get_saved_thumbnail(std::path::Path::new(path)).await {
			Ok(result) => return Ok(result),
			Err(_) => {
				tracing::warn!(path = ?path, "Failed to get saved thumbnail");
			},
		}
	}

	let generated_thumb =
		get_thumbnail(config.thumbnails_directory(), &book.id, image_format).await?;

	let adjusted_config = StumpConfig {
		pdf_prerender_range: 0, // Disable PDF prerendering for thumbnails since we only need the first page
		..config.clone()
	};

	if let Some((content_type, bytes)) = generated_thumb {
		Ok((content_type, bytes))
	} else {
		Ok(get_page(&book.path, 1, &adjusted_config, None, None).await?)
	}
}

pub(crate) async fn get_media_thumbnail_by_id(
	ctx: &Ctx,
	user: &AuthUser,
	book_id: String,
) -> APIResult<ImageResponse> {
	let book = media::Entity::find_for_user(user)
		.columns(media::MediaThumbSelect::columns())
		.filter(media::Column::Id.eq(book_id))
		.into_model::<media::MediaThumbSelect>()
		.one(ctx.conn.as_ref())
		.await?
		.ok_or(APIError::NotFound("Book not found".to_string()))?;

	// Note: This doesn't hard-fail because if the saved thumbnail is missing or corrupt, we want
	// to just pull something else instead of erroring out entirely.
	if let Some(path) = &book.thumbnail_path {
		match get_saved_thumbnail(std::path::Path::new(path)).await {
			Ok(result) => return Ok(result.into()),
			Err(_) => {
				tracing::warn!(path = ?path, "Failed to get saved thumbnail");
			},
		}
	}

	let library_config = library_config::Entity::find()
		.filter(
			library_config::Column::LibraryId.in_subquery(
				Query::select()
					.column(library::Column::Id)
					.from(library::Entity)
					.and_where(
						library::Column::Id.in_subquery(
							Query::select()
								.column(series::Column::LibraryId)
								.from(series::Entity)
								.and_where(series::Column::Id.eq(book.series_id.clone()))
								.to_owned(),
						),
					)
					.to_owned(),
			),
		)
		.one(ctx.conn.as_ref())
		.await?;
	let image_format = library_config.and_then(|o| o.thumbnail_config.map(|c| c.format));

	get_media_thumbnail(&book, image_format, ctx.config.as_ref())
		.await
		.map(ImageResponse::from)
}

pub(crate) async fn get_media_thumbnail_handler(
	Path(id): Path<String>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
) -> APIResult<ImageResponse> {
	get_media_thumbnail_by_id(&ctx, &req.user(), id).await
}

/// Query parameters which can be used to request a specific render quality for a page.
///
/// These are primarily used by the readers to request a higher quality render when the
/// user zooms in, since the default render is sized for a "fit to screen" view.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaPageQuery {
	/// A multiplier applied to the server's configured render quality. A value of `2` will
	/// render the page at twice the configured DPI (and twice the max dimension).
	///
	/// Only applies to PDF files.
	pub scale: Option<f32>,
}

/// The maximum scale which may be requested for a page render. This prevents clients from
/// requesting arbitrarily large images.
const MAX_REQUESTED_SCALE: f32 = 4.0;

async fn get_media_page(
	Path((id, page)): Path<(String, u32)>,
	State(ctx): State<AppState>,
	Extension(req): Extension<AuthContext>,
	axum::extract::Query(query): axum::extract::Query<MediaPageQuery>,
) -> APIResult<ImageResponse> {
	let book = media::Entity::find_for_user(&req.user())
		.filter(media::Column::Id.eq(id.clone()))
		.into_model::<media::MediaIdentSelect>()
		.one(ctx.conn.as_ref())
		.await?
		.ok_or(APIError::NotFound("Book not found".to_string()))?;

	// Clamp the requested quality to sane bounds so that a malicious (or buggy) client
	// cannot request an enormous image.
	let scale = query
		.scale
		.filter(|scale| scale.is_finite() && *scale > 0.0)
		.map(|scale| scale.min(MAX_REQUESTED_SCALE));

	let (dpi_override, max_dim_override) = scale.map_or((None, None), |scale| {
		let config = ctx.config.as_ref();
		(
			Some((config.pdf_render_dpi as f32 * scale).round() as u32),
			Some((config.pdf_max_dimension as f32 * scale).round() as u32),
		)
	});

	let content = get_page(
		&book.path,
		page.try_into()?,
		ctx.config.as_ref(),
		dpi_override,
		max_dim_override,
	)
	.await?;

	Ok(ImageResponse::from(content))
}
