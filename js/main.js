;(function () {
	
	'use strict';

	// iPad and iPod detection	
	var isiPad = function(){
		return (navigator.platform.indexOf("iPad") != -1);
	};

	var isiPhone = function(){
	    return (
			(navigator.platform.indexOf("iPhone") != -1) || 
			(navigator.platform.indexOf("iPod") != -1)
	    );
	};

	var portraitResize = function() {
		var $portrait = $('#geoverse-portrait'),
			winHeight = $(window).height();

		if ( $portrait.data('minheight') < winHeight )  {
			$portrait.height(winHeight);
		}

		$(window).resize(function(){
			var $portrait = $('#geoverse-portrait'),
				winHeight = $(window).height();

			if ( $portrait.data('minheight') < winHeight )  {
				$portrait.height(winHeight);
			}
		})
	};

 	var toggleAside = function() {
		$('.js-geoverse-toggle > a').on('click', function(event){
			$('body').toggleClass('geoverse-showaside');
			$(this).toggleClass('geoverse-active');
			// event.preventDefault();

			$('html, body').animate({
		        scrollTop: $( $.attr(this, 'href') ).offset().top
		    }, 700, 'easeInOutExpo');
		    return false;

		});
	};

	

	// Animate Bio
	var animateBio = function() {
		if ( $('#geoverse-bio-inner').length > 0 ) {
			$('#geoverse-bio-inner .to-animate').each(function(k){

				var el = $(this);
				
				setTimeout ( function () {
					el.addClass('fadeInUp animated');
				},  k * 200, 'easeInOutExpo' );
			});
		}
	};

	// Animate Intro
	var animateIntro = function() {
		if ( $('#geoverse-portrait').length > 0 ) {
			$('#geoverse-portrait .to-animate').each(function(k){

				var el = $(this);
				
				setTimeout ( function () {
					el.addClass('fadeInUp animated');
				},  k * 200, 'easeInOutExpo' );
			});
		}
	};

	// Animate Social
	var animateSocial = function() {
		if ( $('#social-animate').length > 0 ) {
			$('#social-animate .to-animate').each(function(k){

				var el = $(this);
				
				setTimeout ( function () {
					el.addClass('fadeInUp animated');
				},  k * 200, 'easeInOutExpo' );
			});
		}
	};

	

	// Waypoints 
	var bioWayPoint = function() {
		if ($('#geoverse-bio-inner').length > 0 ) {
			$('#geoverse-bio-inner').waypoint( function( direction ) {
										
				if( direction === 'down' && !$(this).hasClass('animated') ) {
					
					setTimeout( animateBio , 200);
					
					$(this).addClass('animated');
						
				}
			} , { offset: '90%' } );
		}
	};
	var introWayPoint = function() {
		if ($('#geoverse-portrait').length > 0 ) {
			$('#geoverse-portrait').waypoint( function( direction ) {
										
				if( direction === 'down' && !$(this).hasClass('animated') ) {
					
					setTimeout( animateIntro , 200);

					setTimeout( animateSocial , 1200);

					setTimeout( function(){
						$('#geoverse-toggle').addClass('fadeInLeft animated')	
					}, 2200);
					
					
					$(this).addClass('animated');
						
				}
			} , { offset: '90%' } );
		}
	};

	

	
	$(function(){
		toggleAside();
		portraitResize();

		bioWayPoint();
		introWayPoint();
	});


}());